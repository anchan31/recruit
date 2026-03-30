import {
    auth, db, onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail,
    collection, addDoc, getDocs, getDoc, doc, updateDoc, deleteDoc, onSnapshot, serverTimestamp, setDoc, query, where, orderBy, writeBatch
} from "./firebase_config.js";


// --- STATE MANAGEMENT ---
let currentUser = null;
let cachedCompanies = [];
let cachedJobs = [];
let cachedCandidates = [];
let cachedInterviews = [];
let cachedOffers = []; // added back
let currentOfferFilter = 'all';

window.filterOffersByStatus = (status) => {
    currentOfferFilter = status;
    document.querySelectorAll('.offer-filter-btn').forEach(btn => {
        if (btn.getAttribute('data-status') === status) {
            btn.classList.add('bg-blue-600', 'text-white', 'shadow-md');
            btn.classList.remove('text-slate-500');
        } else {
            btn.classList.remove('bg-blue-600', 'text-white', 'shadow-md');
            btn.classList.add('text-slate-500');
        }
    });
    renderOffers();
};
let cachedWaTemplates = []; // added back

let cachedTalentPool = [];
let whatsappSelectedCandidates = new Set();
let globalSearchQuery = '';
let candidateView = 'table'; // 'table' or 'cards'
let currentArchiveTab = 'candidates'; // 'candidates' or 'jobs'

window.switchArchiveTab = (tab) => {
    currentArchiveTab = tab;
    document.querySelectorAll('.archive-tab').forEach(btn => {
        if (btn.id === `archive-tab-${tab}`) {
            btn.classList.add('active', 'bg-white', 'dark:bg-blue-600', 'text-blue-600', 'dark:text-white', 'shadow-md');
            btn.classList.remove('text-slate-500');
        } else {
            btn.classList.remove('active', 'bg-white', 'dark:bg-blue-600', 'text-blue-600', 'dark:text-white', 'shadow-md');
            btn.classList.add('text-slate-500');
        }
    });
    renderArchive();
};
// Track initial Firestore loads so loader stays visible until data is ready
let pendingInitialLoads = 0;

// --- OPTIMIZATION: BATCHED RENDERING ---
let renderTimeout = null;
function queueRender() {
    if (renderTimeout) return;
    renderTimeout = requestAnimationFrame(() => {
        renderCurrentSection();
        updateDashboard();
        renderTimeout = null;
    });
}

// --- SESSION TIMEOUT CONFIG ---
const INACTIVITY_TIMEOUT = 45 * 60 * 1000; // 45 minutes
const WARNING_DURATION = 60 * 1000; // 60 seconds
let idleTimer = null;
let warningTimer = null;
let countdownInterval = null;

const searchInput = document.getElementById('global-search');
const clearBtn = document.getElementById('clear-search');
const searchCountEl = document.getElementById('search-count');

function escapeRegex(str) { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function escapeHtml(unsafe) {
    if (unsafe == null) return '';
    return String(unsafe)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
function highlight(text, q) {
    const raw = text == null ? '' : String(text);
    const safe = escapeHtml(raw);
    if (!q) return safe;
    try {
        const re = new RegExp(escapeRegex(q), 'gi');
        return safe.replace(re, match => `<mark class="bg-yellow-200 dark:bg-yellow-600/40">${escapeHtml(match)}</mark>`);
    } catch (e) { return safe; }
}

// Debounce helper
function debounce(fn, wait) {
    let t;
    return function (...args) {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), wait);
    };
}

// --- SESSION TIMEOUT LOGIC ---
function startIdleTimer() {
    stopIdleTimer();
    if (!currentUser) return;

    idleTimer = setTimeout(showInactivityWarning, INACTIVITY_TIMEOUT - WARNING_DURATION);

    // Listen for activity to reset the timer
    ['mousedown', 'mousemove', 'keydown', 'touchstart'].forEach(event => {
        window.addEventListener(event, resetIdleTimer, { once: true });
    });
}

function stopIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    if (warningTimer) clearTimeout(warningTimer);
    if (countdownInterval) clearInterval(countdownInterval);

    ['mousedown', 'mousemove', 'keydown', 'touchstart'].forEach(event => {
        window.removeEventListener(event, resetIdleTimer);
    });
}

window.resetIdleTimer = function () {
    closeModal('modal-inactivity');
    startIdleTimer();
};

function showInactivityWarning() {
    openModal('modal-inactivity');
    let secondsLeft = WARNING_DURATION / 1000;
    const countdownEl = document.getElementById('inactivity-countdown');
    if (countdownEl) countdownEl.innerText = secondsLeft;

    countdownInterval = setInterval(() => {
        secondsLeft--;
        if (countdownEl) countdownEl.innerText = secondsLeft;
        if (secondsLeft <= 0) {
            clearInterval(countdownInterval);
        }
    }, 1000);

    warningTimer = setTimeout(handleAutoLogout, WARNING_DURATION);
}

async function handleAutoLogout() {
    showToast("Logged out due to inactivity.");
    await signOut(auth);
}

function computeSearchCount(query) {
    if (!query) return 0;
    const q = query.toLowerCase();
    let count = 0;
    count += cachedCandidates.filter(c =>
    ((c.name || '').toLowerCase().includes(q) ||
        (c.email || '').toLowerCase().includes(q) ||
        (c.phone || '').toLowerCase().includes(q))
    ).length;
    count += cachedJobs.filter(j => (j.title || '').toLowerCase().includes(q) || (j.department || '').toLowerCase().includes(q)).length;
    count += cachedCompanies.filter(c => (c.name || '').toLowerCase().includes(q)).length;
    return count;
}

function updateSearchCount() {
    const q = searchInput.value.trim();
    const cnt = computeSearchCount(q);
    if (searchCountEl) {
        searchCountEl.innerText = cnt + ' result' + (cnt === 1 ? '' : 's');
        searchCountEl.classList.toggle('hidden', cnt === 0);
    }
}

function getEffectiveQuery(section) {
    if (!searchInput) return '';
    return searchInput.value.trim().toLowerCase();
}

// Prefill job location when company is selected (always override per user request)
function prefillJobLocationFromCompany() {
    const sel = document.getElementById('job-company-select');
    const locInput = document.querySelector('#form-job [name=location]');
    if (!sel || !locInput) return;
    const companyId = sel.value;
    const company = cachedCompanies.find(c => c.id === companyId);
    if (company) {
        locInput.value = company.location || company.address || '';
    }
}

const handleSearchInput = debounce((e) => {
    globalSearchQuery = e.target.value.toLowerCase();
    clearBtn.classList.toggle('hidden', !globalSearchQuery);
    updateSearchCount();
    renderCurrentSection();
}, 250);

searchInput.addEventListener('input', handleSearchInput);

clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    globalSearchQuery = '';
    clearBtn.classList.add('hidden');
    updateSearchCount();
    renderCurrentSection();
    searchInput.focus();
});



// Keyboard shortcut: Ctrl/Cmd+K to focus search
window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchInput.focus();
    }
});

// Global Escape Key to close modals
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const modals = ['modal-company', 'modal-job', 'modal-candidate', 'modal-interview', 'modal-wa-template', 'modal-reports'];
        modals.forEach(id => {
            const el = document.getElementById(id);
            if (el && !el.classList.contains('hidden')) closeModal(id);
        });
    }
});

function renderCurrentSection() {
    renderCompanies();
    renderJobs();
    renderCandidates();
    renderWaCandidatesChecklist();
    renderInterviews();
    if (typeof renderTalentPool === 'function') renderTalentPool();
    if (typeof renderInboxCandidates === 'function') renderInboxCandidates();
    if (typeof renderOffers === 'function') renderOffers();
}

function toggleCandidateView() {
    candidateView = candidateView === 'table' ? 'cards' : 'table';
    const btn = document.getElementById('btn-toggle-candidates-view');
    if (btn) btn.innerHTML = candidateView === 'table' ? '<i class="fas fa-table"></i>' : '<i class="fas fa-th-large"></i>';
    renderCandidates();
}

function exportCandidatesCSV() {
    const rows = [];
    const list = (function () {
        // reuse filter logic from renderCandidates
        const filterVal = document.getElementById('filter-budget').value;
        const q = getEffectiveQuery('candidates');
        let arr = cachedCandidates.filter(c => {
            if (c.inTalentPool) return false;
            const job = cachedJobs.find(j => j.id === c.jobId || j.title === c.jobId);
            const jobTitle = job ? job.title.toLowerCase() : (c.jobId || '').toLowerCase();
            if (!q) return true;
            return (c.name || '').toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q) || jobTitle.includes(q) || (c.phone || '').toLowerCase().includes(q);
        });
        if (filterVal !== 'all') {
            arr = arr.filter(c => {
                const job = cachedJobs.find(j => j.id === c.jobId);
                if (!job) return true;
                const jobBudget = job.budget ? Number(job.budget) : (job.budgetMax ? Number(job.budgetMax) : 0);
                return filterVal === 'within' ? Number(c.expectedCTC || c.expectedSalary || 0) <= jobBudget : Number(c.expectedCTC || c.expectedSalary || 0) > jobBudget;
            });
        }
        return arr;
    })();
    if (list.length === 0) { alert('No candidates to export'); return; }
    const headers = ['Name', 'Email', 'Phone', 'Experience', 'ExpectedCTC', 'CurrentCTC', 'Job'];
    rows.push(headers.join(','));
    list.forEach(c => {
        const job = cachedJobs.find(j => j.id === c.jobId);
        const vals = [c.name || '', c.email || '', c.phone || '', c.experience || '', c.expectedCTC || '', c.currentCTC || '', job ? job.title : ''];
        rows.push(vals.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(','));
    });
    const csv = rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'candidates_export.csv'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

function bulkSelectAndMessage() {
    // select all filtered candidates and go to messaging view
    const list = (function () {
        const q = getEffectiveQuery('candidates');
        const filterVal = document.getElementById('filter-budget').value;
        let arr = cachedCandidates.filter(c => {
            if (c.inTalentPool) return false;
            const job = cachedJobs.find(j => j.id === c.jobId || j.title === c.jobId);
            const jobTitle = job ? job.title.toLowerCase() : (c.jobId || '').toLowerCase();
            if (!q) return true;
            return (c.name || '').toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q) || jobTitle.includes(q) || (c.phone || '').toLowerCase().includes(q);
        });
        if (filterVal !== 'all') {
            arr = arr.filter(c => {
                const job = cachedJobs.find(j => j.id === c.jobId);
                if (!job) return true;
                const jobBudget = job.budget ? Number(job.budget) : (job.budgetMax ? Number(job.budgetMax) : 0);
                return filterVal === 'within' ? Number(c.expectedCTC || c.expectedSalary || 0) <= jobBudget : Number(c.expectedCTC || c.expectedSalary || 0) > jobBudget;
            });
        }
        return arr;
    })();
    whatsappSelectedCandidates = new Set(list.map(c => c.id));
    renderWaCandidatesChecklist();
    showSection('messaging');
}

// --- AUTH LOGIC ---
const loginBtn = document.getElementById('btn-login');

const resetBtn = document.getElementById('btn-reset');

window.toggleAuthView = (view) => {
    const loginView = document.getElementById('login-view');
    const forgotView = document.getElementById('forgot-view');
    const errorP = document.getElementById('auth-error');
    const resetErrorP = document.getElementById('reset-error');
    const resetSuccessP = document.getElementById('reset-success');

    if (errorP) errorP.classList.add('hidden');
    if (resetErrorP) resetErrorP.classList.add('hidden');
    if (resetSuccessP) resetSuccessP.classList.add('hidden');

    if (view === 'forgot') {
        loginView.classList.add('hidden');
        forgotView.classList.remove('hidden');
        forgotView.classList.add('animate-fade-in');
    } else {
        loginView.classList.remove('hidden');
        loginView.classList.add('animate-fade-in');
        forgotView.classList.add('hidden');
    }
};

window.handleSocialLogin = (provider) => {
    showToast(`${provider} login coming soon! Currently, please use your work email.`);
};

async function handleLogin() {
    const email = document.getElementById('auth-email').value;
    const pass = document.getElementById('auth-password').value;
    if (!email || !pass) {
        showError("Please enter both email and password.");
        return;
    }
    const orig = loginBtn.innerText; loginBtn.innerText = 'Signing in...'; loginBtn.disabled = true;
    try {
        await signInWithEmailAndPassword(auth, email, pass);
    } catch (err) { showError(err.message); }
    finally { loginBtn.innerText = orig; loginBtn.disabled = false; }
}

loginBtn.addEventListener('click', handleLogin);

// Enter Key Support for Login
document.getElementById('auth-email').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') document.getElementById('auth-password').focus();
});
document.getElementById('auth-password').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleLogin();
});

// Caps Lock Detection
const authPassInput = document.getElementById('auth-password');
const capsWarning = document.getElementById('caps-lock-warning');

if (authPassInput && capsWarning) {
    authPassInput.addEventListener('keyup', (e) => {
        if (typeof e.getModifierState === 'function' && e.getModifierState('CapsLock')) {
            capsWarning.classList.remove('hidden');
        } else {
            capsWarning.classList.add('hidden');
        }
    });

    // Also check on focus/blur
    authPassInput.addEventListener('keydown', (e) => {
        if (typeof e.getModifierState === 'function' && e.getModifierState('CapsLock')) {
            capsWarning.classList.remove('hidden');
        } else {
            capsWarning.classList.add('hidden');
        }
    });

    authPassInput.addEventListener('focus', () => {
        // We can't check CapsLock on focus directly as FocusEvent doesn't support getModifierState
        // The keydown/keyup listeners will handle it once the user starts typing
    });

    authPassInput.addEventListener('blur', () => {
        capsWarning.classList.add('hidden');
    });
}

// Forgot Password Action
if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
        const email = document.getElementById('reset-email').value;
        const resetError = document.getElementById('reset-error');
        const resetSuccess = document.getElementById('reset-success');

        if (!email) {
            resetError.innerText = "Please enter your email address.";
            resetError.classList.remove('hidden');
            return;
        }

        const orig = resetBtn.innerText; resetBtn.innerText = 'Sending...'; resetBtn.disabled = true;
        resetError.classList.add('hidden');
        resetSuccess.classList.add('hidden');

        try {
            await sendPasswordResetEmail(auth, email);
            resetSuccess.innerText = "Password reset email sent! Please check your inbox.";
            resetSuccess.classList.remove('hidden');
            document.getElementById('reset-email').value = '';
        } catch (err) {
            resetError.innerText = getFriendlyErrorMessage(err.message);
            resetError.classList.remove('hidden');

            resetBtn.innerText = orig;
            resetBtn.disabled = false;
        }
    });
}



onAuthStateChanged(auth, async (user) => {
    if (user && !user.isAnonymous) {
        // AUTHORIZATION CHECK
        const allowedEmails = ['hrd@brawnlabs.in', 'talentacq@brawnlabs.in', 'chandansingh22004@gmail.com'];
        if (!user.email || !allowedEmails.includes(user.email.toLowerCase())) {
            alert('Access Denied. Only authorized HR personnel can access this dashboard.');
            await auth.signOut();
            return;
        }

        currentUser = user;
        document.getElementById('auth-container').classList.add('hidden');
        document.getElementById('main-app').classList.remove('hidden');

        // Ensure FAB is only visible after successful login
        const fab = document.getElementById('fab-container');
        if (fab) {
            fab.style.display = 'flex';
        }


        // Update navbar profile
        const navEmail = document.getElementById('nav-user-email');
        const navName = document.getElementById('nav-user-name');
        const navInitial = document.getElementById('user-initial-nav');
        const menuEmail = document.getElementById('menu-user-email');

        const displayEmail = user.email;

        if (navEmail) navEmail.innerText = displayEmail;
        if (navName) navName.innerText = user.displayName || (user.email ? user.email.split('@')[0] : 'HR Admin');
        if (navInitial) navInitial.innerText = (user.displayName ? user.displayName[0] : (displayEmail[0])).toUpperCase();
        if (menuEmail) menuEmail.innerText = displayEmail;

        startIdleTimer();
        initApp();
    } else {
        currentUser = null;
        stopIdleTimer();
        document.getElementById('auth-container').classList.remove('hidden');
        document.getElementById('main-app').classList.add('hidden');
        // Hide FAB when logged out
        const fab = document.getElementById('fab-container');
        if (fab) {
            fab.style.display = 'none';
        }
        const modal = document.getElementById('modal-inactivity');
        if (modal) modal.classList.add('hidden');
    }
});

// --- CORE DATA FUNCTIONS ---
async function initApp() {
    // When app starts after login, show loader until first data snapshots arrive
    pendingInitialLoads = 6; // companies, jobs, candidates, interviews, offers, waTemplates
    showLoader();
    setupRealtimeListeners();
    showSection('dashboard');

    // Safety Fallback: Hide loader after 5 seconds even if some snapshots fail to load
    // This prevents being stuck at 'Signing in...' in case of persistence errors
    setTimeout(() => {
        if (pendingInitialLoads > 0) {
            console.warn(`Boot Resilience: Hiding loader despite ${pendingInitialLoads} pending snapshots.`);
            pendingInitialLoads = 0;
            hideLoader();
        }
    }, 5000);
}

function setupRealtimeListeners() {
    const handleError = (collectionName, error) => {
        console.error(`Error in ${collectionName} listener:`, error);
        if (pendingInitialLoads > 0) {
            pendingInitialLoads--;
            if (pendingInitialLoads === 0) hideLoader();
        }
    };

    const logSource = (collectionName, snapshot) => {
        const source = snapshot.metadata.fromCache ? "local cache" : "server";
        console.log(`[Firestore] ${collectionName} loaded from ${source} (${snapshot.size} docs)`);
    };

    // Listen for Companies
    const compQuery = collection(db, "companies");
    onSnapshot(compQuery, (snapshot) => {
        logSource("Companies", snapshot);
        cachedCompanies = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        updateDropdowns();
        queueRender();
        if (pendingInitialLoads > 0) {
            pendingInitialLoads--;
            if (pendingInitialLoads === 0) hideLoader();
        }
    }, (error) => handleError("Companies", error));

    // Listen for Jobs
    const jobsQuery = collection(db, "jobs");
    onSnapshot(jobsQuery, (snapshot) => {
        logSource("Jobs", snapshot);
        cachedJobs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        updateDropdowns();
        if (typeof renderTalentPool === 'function') renderTalentPool();
        queueRender();
        if (pendingInitialLoads > 0) {
            pendingInitialLoads--;
            if (pendingInitialLoads === 0) hideLoader();
        }
    }, (error) => handleError("Jobs", error));

    // Listen for Candidates (Unified)
    const candidateQuery = collection(db, "candidates");
    onSnapshot(candidateQuery, (snapshot) => {
        logSource("Candidates", snapshot);
        cachedCandidates = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        cachedTalentPool = cachedCandidates.filter(c => c.inTalentPool);

        if (typeof renderTalentPool === 'function') renderTalentPool();
        if (typeof updateTalentPoolBadge === 'function') updateTalentPoolBadge();
        queueRender();
        if (pendingInitialLoads > 0) {
            pendingInitialLoads--;
            if (pendingInitialLoads === 0) hideLoader();
        }
    }, (error) => handleError("Candidates", error));

    // Listen for Interviews
    const interviewQuery = collection(db, "interviews");
    onSnapshot(interviewQuery, (snapshot) => {
        logSource("Interviews", snapshot);
        cachedInterviews = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        // Auto-Cleanup: Delete interviews older than 14 days if Done/Rejected
        autoCleanupOldInterviews();

        queueRender();
        if (pendingInitialLoads > 0) {
            pendingInitialLoads--;
            if (pendingInitialLoads === 0) hideLoader();
        }
    }, (error) => handleError("Interviews", error));

    // Listen for Offers
    const offersQuery = query(collection(db, "offers"), orderBy("createdAt", "desc"));
    onSnapshot(offersQuery, (snapshot) => {
        logSource("Offers", snapshot);
        cachedOffers = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        queueRender();
        if (pendingInitialLoads > 0) {
            pendingInitialLoads--;
            if (pendingInitialLoads === 0) hideLoader();
        }
    }, (error) => handleError("Offers", error));

    // Listen for WhatsApp Templates
    const waQuery = collection(db, "whatsappTemplates");
    onSnapshot(waQuery, (snapshot) => {
        logSource("WhatsApp Templates", snapshot);
        cachedWaTemplates = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        updateWaDropdowns();
        queueRender();
        if (pendingInitialLoads > 0) {
            pendingInitialLoads--;
            if (pendingInitialLoads === 0) hideLoader();
        }
    }, (error) => handleError("WhatsApp Templates", error));
}

// --- WHATSAPP FUNCTIONS ---
function renderWaTemplates() {
    const container = document.getElementById('wa-templates-list');
    if (cachedWaTemplates.length === 0) {
        container.innerHTML = `<div class="text-sm p-4 text-center border border-dashed rounded-lg" style="color: var(--text-muted); border-color: var(--border-color)">No templates saved yet.</div>`;
        return;
    }
    container.innerHTML = cachedWaTemplates.map(t => `
                <div class="glass-card p-4 rounded-xl flex justify-between items-center group cursor-pointer hover:bg-slate-500/5 transition-colors" onclick="selectTemplateFromList('${t.id}')">
                    <div class="flex-1 truncate pr-4">
                        <div class="flex items-center gap-2">
                            <h4 class="font-bold text-md truncate" style="color: var(--text-primary)">${t.name}</h4>
                            <span class="badge badge-blue text-[10px]">${t.type}</span>
                        </div>
                        <p class="text-sm truncate mt-1" style="color: var(--text-muted)">${t.content}</p>
                    </div>
                    <div class="flex gap-2">
                        <button onclick="event.stopPropagation(); editWaTemplate('${t.id}')" class="p-2 text-slate-400 hover:text-blue-400 opacity-0 group-hover:opacity-100 transition"><i class="fas fa-edit"></i></button>
                        <button onclick="event.stopPropagation(); deleteDocById('whatsappTemplates', '${t.id}')" class="p-2 text-slate-400 hover:text-red-400 opacity-0 group-hover:opacity-100 transition"><i class="fas fa-trash"></i></button>
                    </div>
                </div>
            `).join('');
}

function updateWaDropdowns() {
    const select = document.getElementById('wa-template-select');
    if (!select) return;
    const currentVal = select.value;
    select.innerHTML = '<option value="">-- Choose Template --</option>' +
        cachedWaTemplates.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
    if (currentVal && cachedWaTemplates.find(t => t.id === currentVal)) select.value = currentVal;

    // Re-initialize custom select to sync the UI
    try { initCustomSelects(); } catch (e) { console.warn('Sync failed in updateWaDropdowns', e); }
}

window.filterTemplates = (query) => {
    const q = query.toLowerCase();
    const container = document.getElementById('wa-templates-list');
    const filtered = cachedWaTemplates.filter(t => t.name.toLowerCase().includes(q) || t.content.toLowerCase().includes(q));

    if (filtered.length === 0) {
        container.innerHTML = `<div class="text-xs p-8 text-center border-2 border-dashed border-slate-200 dark:border-slate-800 rounded-2xl text-slate-400">No matching templates found</div>`;
        return;
    }

    container.innerHTML = filtered.map(t => `
        <div class="glass-card p-5 rounded-2xl flex justify-between items-center group cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50 border-slate-100 dark:border-slate-800 transition-all shadow-sm hover:shadow-md" onclick="selectTemplateFromList('${t.id}')">
            <div class="flex-1 truncate pr-4">
                <div class="flex items-center gap-3 mb-1">
                    <h4 class="font-bold text-slate-800 dark:text-white truncate">${t.name}</h4>
                    <span class="text-[9px] font-black uppercase tracking-widest text-slate-400 px-2 py-0.5 bg-slate-100 dark:bg-slate-900/50 rounded-full">${t.type || 'Chat'}</span>
                </div>
                <p class="text-xs text-slate-500 truncate">${t.content}</p>
            </div>
            <div class="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onclick="event.stopPropagation(); editWaTemplate('${t.id}')" class="w-8 h-8 flex items-center justify-center rounded-lg bg-white dark:bg-slate-800 text-slate-400 hover:text-blue-500 shadow-sm border border-slate-100 dark:border-slate-700 transition-colors"><i class="fas fa-edit text-xs"></i></button>
                <button onclick="event.stopPropagation(); deleteDocById('whatsappTemplates', '${t.id}')" class="w-8 h-8 flex items-center justify-center rounded-lg bg-white dark:bg-slate-800 text-slate-400 hover:text-red-500 shadow-sm border border-slate-100 dark:border-slate-700 transition-colors"><i class="fas fa-trash text-xs"></i></button>
            </div>
        </div>
    `).join('');
};

function renderWaCandidatesChecklist() {
    const container = document.getElementById('wa-candidates-checklist');

    // Scoped search filter for WA checklist
    const q = getEffectiveQuery('candidates');
    const rejectedStages = ['REJECTED', 'Rejected', 'Backed Out', 'Not Interested'];
    let list = cachedCandidates.filter(c => {
        // Exclude rejected/inactive from the messaging list to keep it clean
        if (rejectedStages.includes(c.stage)) return false;

        if (!q) return true;
        const qn = q.toLowerCase();
        return (c.name || '').toLowerCase().includes(qn) || (c.phone && c.phone.replace(/[^0-9]/g, '').includes(qn.replace(/[^0-9]/g, '')));
    });

    if (list.length === 0) {
        container.innerHTML = `<div class="text-slate-500 text-xs p-2">No candidates found matching the search.</div>`;
        return;
    }

    container.innerHTML = list.map(c => {
        const isContact = c.isContact === true;
        return `
                <div class="flex items-center justify-between p-3 hover:bg-slate-500/5 rounded border-b last:border-0" style="border-color: var(--border-color)">
                    <div class="flex items-center gap-3">
                        <input type="checkbox" id="wacand-${c.id}" value="${c.id}" class="wa-cand-checkbox h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" ${whatsappSelectedCandidates.has(c.id) ? 'checked' : ''} onchange="toggleWaCandidate('${c.id}', this.checked)">
                        <label for="wacand-${c.id}" class="text-sm cursor-pointer select-none">
                            <div class="font-bold" style="color: var(--text-primary)">${highlight(c.name, q)}</div>
                            <div class="text-xs" style="color: var(--text-muted)">${c.phone || 'No Phone Number'}</div>
                        </label>
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="badge badge-gray text-[10px] uppercase font-bold tracking-wider">${c.stage}</span>
                        <button onclick="toggleContactStatus('${c.id}')" class="px-2 py-1 rounded-lg text-[10px] ${isContact ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'}">
                            ${isContact ? 'Remove Contact' : 'Save to Contacts'}
                        </button>
                    </div>
                </div>
            `;
    }).join('');
}

window.toggleWaCandidate = (id, isChecked) => {
    if (isChecked) whatsappSelectedCandidates.add(id);
    else whatsappSelectedCandidates.delete(id);
};

window.toggleAllCandidates = (checkbox) => {
    const checkboxes = document.querySelectorAll('.wa-cand-checkbox');
    checkboxes.forEach(cb => {
        cb.checked = checkbox.checked;
        toggleWaCandidate(cb.value, cb.checked);
    });
};

window.selectTemplateFromList = (id) => {
    document.getElementById('wa-template-select').value = id;
    previewSelectedTemplate();
};

function formatWaMessage(content, prospect, interview = null) {
    let msg = content;
    const job = cachedJobs.find(j => j.id === (prospect ? prospect.jobId : null));
    const company = job ? cachedCompanies.find(c => c.id === job.companyId) : null;

    const variables = {
        name: prospect ? prospect.name : 'Candidate Name',
        firstName: prospect ? prospect.name.split(' ')[0] : 'Candidate',
        phone: prospect ? (prospect.phone || '') : '',
        email: prospect ? prospect.email : 'candidate@email.com',
        stage: prospect ? (prospect.stage || 'Applied') : 'Applied',
        jobTitle: job ? job.title : 'the position',
        department: job ? (job.department || '') : '',
        designation: job ? (job.designation || '') : '',
        salary: job ? (job.salary || '') : '',
        location: job ? (job.location || '') : '',
        company: company ? company.name : (job ? (job.company || 'Brawn Labs') : 'Brawn Labs'),
        companyAddress: company ? (company.address || company.location || '') : '',
        interviewDate: interview ? new Date(interview.dateTime).toLocaleDateString() : 'Date',
        interviewTime: interview ? new Date(interview.dateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Time',
        interviewMode: interview ? interview.mode : 'Mode',
        interviewer: interview ? (interview.interviewer || 'Interviewer') : 'Interviewer',
        meetingLink: interview ? (interview.meetingLink || interview.location || '') : '',
        todayDate: new Date().toLocaleDateString()
    };

    Object.keys(variables).forEach(key => {
        const regex = new RegExp('{{' + key + '}}', 'g');
        msg = msg.replace(regex, variables[key]);
    });
    return msg;
}

window.previewSelectedTemplate = () => {
    const select = document.getElementById('wa-template-select');
    const previewArea = document.getElementById('wa-live-preview');

    if (!select.value) {
        previewArea.innerHTML = `<div class="wa-message-bubble">Your message preview will appear here...</div>`;
        return;
    }

    const template = cachedWaTemplates.find(t => t.id === select.value);
    if (template) {
        const firstSelectedId = Array.from(whatsappSelectedCandidates)[0] || null;
        const demoCandidate = cachedCandidates.find(c => c.id === firstSelectedId) || null;

        let formatted = formatWaMessage(template.content, demoCandidate);
        previewArea.innerHTML = `
            <div class="wa-message-bubble max-w-[85%] bg-white dark:bg-slate-800 p-3 rounded-2xl rounded-tl-none text-xs shadow-sm self-start">
                <p class="text-slate-700 dark:text-slate-200">${formatted}</p>
                <span class="text-[8px] text-slate-400 block text-right mt-1">${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
        `;

        const nameEl = document.getElementById('preview-candidate-name');
        if (nameEl) nameEl.innerText = demoCandidate ? demoCandidate.name : 'Recipient Name';
    }
};

window.updateLivePreviewOnEdit = () => {
    const content = document.getElementById('wa-tpl-content').value;
    const previewArea = document.getElementById('wa-live-preview');
    const previewModal = document.getElementById('wa-modal-preview');

    const defHtml = `<div class="wa-message-bubble">Your message preview will appear here...</div>`;
    if (!content) {
        if (previewArea) previewArea.innerHTML = defHtml;
        if (previewModal) previewModal.innerHTML = defHtml;
        return;
    }
    let formatted = formatWaMessage(content, null);
    const contentHtml = `<div class="wa-message-bubble">${formatted}</div>`;
    if (previewArea) previewArea.innerHTML = contentHtml;
    if (previewModal) previewModal.innerHTML = contentHtml;
};

window.insertWaTag = (tag) => {
    const textarea = document.getElementById('wa-tpl-content');
    textarea.setRangeText(`{{${tag}}}`, textarea.selectionStart, textarea.selectionEnd, 'end');
    textarea.focus();
    updateLivePreviewOnEdit();
};

window.sendBulkWhatsApp = async () => {
    const templateId = document.getElementById('wa-template-select').value;
    if (!templateId) {
        alert("Please select a template first.");
        return;
    }
    if (whatsappSelectedCandidates.size === 0) {
        alert("Please select at least one candidate.");
        return;
    }

    const template = cachedWaTemplates.find(t => t.id === templateId);
    const prospectsToSend = Array.from(whatsappSelectedCandidates).map(id => cachedCandidates.find(c => c.id === id)).filter(p => !!p);

    const missingPhones = prospectsToSend.filter(p => !p.phone);
    if (missingPhones.length > 0) {
        if (!confirm(`${missingPhones.length} candidate(s) are missing phone numbers and will be skipped. Continue?`)) return;
    }

    const validProspects = prospectsToSend.filter(p => !!p.phone);
    if (validProspects.length === 0) {
        alert("No valid candidates with phone numbers to send messages to.");
        return;
    }

    if (!confirm(`This will open WhatsApp Web ${validProspects.length} times to send messages. Continue?`)) return;

    showToast(`Starting sending process for ${validProspects.length} candidates...`);

    for (let i = 0; i < validProspects.length; i++) {
        const p = validProspects[i];
        const message = formatWaMessage(template.content, p);

        const cleanPhone = p.phone.replace(/[^0-9+]/g, '');

        const url = new URL('https://api.whatsapp.com/send');
        url.searchParams.set('phone', cleanPhone);
        url.searchParams.set('text', message);

        window.open(url.toString(), '_blank');

        if (i < validProspects.length - 1) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    showToast("All WhatsApp tabs opened.");
};

window.sendBulkEmail = async () => {
    const templateId = document.getElementById('wa-template-select').value;
    if (!templateId) {
        alert("Please select a template first.");
        return;
    }
    if (whatsappSelectedCandidates.size === 0) {
        alert("Please select at least one candidate.");
        return;
    }

    const template = cachedWaTemplates.find(t => t.id === templateId);
    const prospectsToSend = Array.from(whatsappSelectedCandidates).map(id => cachedCandidates.find(c => c.id === id)).filter(p => !!p);

    const missingEmails = prospectsToSend.filter(p => !p.email);
    if (missingEmails.length > 0) {
        if (!confirm(`${missingEmails.length} candidate(s) are missing emails and will be skipped. Continue?`)) return;
    }

    const validProspects = prospectsToSend.filter(p => !!p.email);
    if (validProspects.length === 0) {
        alert("No valid candidates with emails to send messages to.");
        return;
    }

    if (!confirm(`This will open your email client ${validProspects.length} times. Continue?`)) return;

    showToast(`Starting sending process for ${validProspects.length} candidates...`);

    for (let i = 0; i < validProspects.length; i++) {
        const p = validProspects[i];
        const message = formatWaMessage(template.content, p);

        const job = cachedJobs.find(j => j.id === p.jobId);
        const company = job ? cachedCompanies.find(c => c.id === job.companyId) : null;
        const companyName = company ? company.name : (job ? (job.company || 'Recruitment Team') : 'Recruitment Team');
        const subject = encodeURIComponent(`Message from ${companyName} regarding ${job ? job.title : 'opportunities'}`);
        const body = encodeURIComponent(message);

        const url = `mailto:${p.email}?subject=${subject}&body=${body}`;
        window.open(url, '_blank');

        if (i < validProspects.length - 1) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    showToast("All email drafts opened.");
};

function renderJobs() {
    const container = document.getElementById('jobs-list');
    const statusFilter = document.getElementById('filter-job-status').value;
    const priorityFilter = document.getElementById('filter-job-priority').value;
    const deptFilter = document.getElementById('filter-job-department').value;
    const desigFilter = document.getElementById('filter-job-designation').value;
    const q = getEffectiveQuery('jobs');

    // Update Dynamic Filters (Departments & Designations)
    const depts = [...new Set(cachedJobs.map(j => j.department).filter(Boolean))];
    const desigs = [...new Set(cachedJobs.map(j => j.designation).filter(Boolean))];

    const deptSelect = document.getElementById('filter-job-department');
    const desigSelect = document.getElementById('filter-job-designation');

    if (deptSelect.options.length <= 1 && depts.length > 0) {
        depts.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d; opt.innerText = d;
            deptSelect.appendChild(opt);
        });
    }
    if (desigSelect.options.length <= 1 && desigs.length > 0) {
        desigs.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d; opt.innerText = d;
            desigSelect.appendChild(opt);
        });
    }

    let filtered = cachedJobs.filter(j => {
        // Default to Open if no status filter set, and exclude Closed from main list unless explicitly asked
        const matchStatus = statusFilter === 'all'
            ? j.status !== 'Closed'
            : j.status === statusFilter;
        const matchPriority = priorityFilter === 'all' || j.priority === priorityFilter;
        const matchDept = deptFilter === 'all' || j.department === deptFilter;
        const matchDesig = desigFilter === 'all' || j.designation === desigFilter;
        const matchSearch = !q || j.title.toLowerCase().includes(q) ||
            (j.department && j.department.toLowerCase().includes(q));
        return matchStatus && matchPriority && matchDept && matchDesig && matchSearch;
    });

    if (filtered.length === 0) {
        container.innerHTML = '<div class="text-slate-400 p-8 col-span-full text-center bg-slate-800/20 rounded-2xl border border-dashed border-slate-700">No jobs found matching criteria.</div>';
        return;
    }

    container.innerHTML = filtered.map(j => {
        const company = cachedCompanies.find(c => c.id === j.companyId);
        const candidatesForJob = cachedCandidates.filter(c => c.jobId === j.id);

        const stats = {
            total: candidatesForJob.length,
            active: candidatesForJob.filter(c => ['Screening', 'Interview', 'Selected'].includes(c.stage)).length,
            hired: candidatesForJob.filter(c => c.stage === 'Hired').length
        };

        const priorityColors = {
            'Urgent': 'text-red-500 bg-red-100 dark:bg-red-900/30',
            'Medium': 'text-orange-500 bg-orange-100 dark:bg-orange-900/30',
            'Low': 'text-blue-500 bg-blue-100 dark:bg-blue-900/30'
        };
        const pColor = priorityColors[j.priority] || 'text-slate-500 bg-slate-100 dark:bg-slate-900/30';

        const statusColors = {
            'Open': 'bg-slate-100 dark:bg-slate-800 text-slate-500',
            'Closed': 'bg-red-50 dark:bg-red-900/30 text-red-500',
            'Draft': 'bg-yellow-50 dark:bg-yellow-900/30 text-yellow-600'
        };
        const sColor = statusColors[j.status] || statusColors['Open'];

        const toggleIcon = j.status === 'Open' ? '<i class="fas fa-eye-slash"></i>' : '<i class="fas fa-eye"></i>';
        const toggleTitle = j.status === 'Open' ? 'Close Job' : 'Open Job';
        const toggleClass = j.status === 'Open' ? 'hover:text-orange-500 text-slate-400' : 'hover:text-emerald-500 text-slate-400';

        return `
                <div class="glass-card p-4 rounded-xl border border-slate-200 dark:border-slate-800 hover:border-blue-500/50 transition-all group overflow-hidden ${j.status === 'Closed' ? 'opacity-80' : ''}">
                    
                    <div class="flex flex-col lg:flex-row gap-4 lg:items-center">
                        
                        <!-- Left: Job Info -->
                        <div class="flex-[2] min-w-0 pr-2 lg:pr-0">
                            <div class="flex items-center gap-2 mb-1.5 flex-wrap">
                                <span class="text-[9px] font-bold uppercase tracking-widest ${pColor} px-2 py-0.5 rounded-full">${j.priority || 'Medium'}</span>
                                <span class="text-[9px] font-bold uppercase tracking-widest ${sColor} px-2 py-0.5 rounded-full">${j.status || 'Open'}</span>
                                
                                <!-- Hover Actions -->
                                <div class="ml-auto flex gap-1 lg:opacity-0 group-hover:opacity-100 transition-opacity">
                                    <button onclick="toggleJobStatus('${j.id}', '${j.status}')" class="p-1.5 flex items-center justify-center ${toggleClass} rounded bg-slate-50 dark:bg-slate-800 shadow-sm border border-slate-100 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 transition" title="${toggleTitle}">${toggleIcon}</button>
                                    <button onclick="showJobDetails('${j.id}')" class="p-1.5 flex items-center justify-center text-slate-400 hover:text-blue-500 rounded bg-slate-50 dark:bg-slate-800 shadow-sm border border-slate-100 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 transition" title="View Details"><i class="fas fa-info-circle text-xs"></i></button>
                                    <button onclick="editJob('${j.id}')" class="p-1.5 flex items-center justify-center text-slate-400 hover:text-blue-500 rounded bg-slate-50 dark:bg-slate-800 shadow-sm border border-slate-100 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 transition" title="Edit Job"><i class="fas fa-edit text-xs"></i></button>
                                    <button onclick="deleteDocById('jobs', '${j.id}')" class="p-1.5 flex items-center justify-center text-slate-400 hover:text-red-500 rounded bg-slate-50 dark:bg-slate-800 shadow-sm border border-slate-100 dark:border-slate-700 hover:bg-red-50 dark:hover:bg-red-900/30 transition" title="Delete Job"><i class="fas fa-trash text-xs"></i></button>
                                </div>
                            </div>
                            <h4 class="text-lg font-bold text-slate-800 dark:text-white truncate" title="${j.title}">${highlight(j.title, q)}</h4>
                            <p class="text-xs text-blue-500 font-medium truncate mb-2">${highlight(company ? company.name : 'Unknown Company', q)}</p>
                            
                            <div class="flex items-center gap-4 text-[11px] text-slate-500 flex-wrap">
                                <div class="flex items-center gap-1.5 bg-slate-100 dark:bg-slate-800/50 px-2 py-1 rounded-md">
                                    <i class="fas fa-layer-group text-slate-400"></i>
                                    <span class="truncate">${j.department || 'N/A'}</span>
                                </div>
                                <div class="flex items-center gap-1.5 bg-slate-100 dark:bg-slate-800/50 px-2 py-1 rounded-md">
                                    <i class="fas fa-indian-rupee-sign text-slate-400"></i>
                                    <span>₹${j.budget ? (j.budget / 100000).toFixed(1) + 'L' : 'N/A'} <span class="text-[10px] text-blue-500 font-semibold ml-1">${j.budget ? '(₹' + Math.round(j.budget / 12).toLocaleString() + '/mo)' : ''}</span></span>
                                </div>
                            </div>
                        </div>

                        <!-- Middle: Stats Pipeline -->
                        <div class="flex-1 bg-slate-50 dark:bg-slate-900/40 rounded-xl p-3 border border-slate-100 dark:border-slate-800/50">
                            <p class="text-[9px] font-bold uppercase tracking-widest text-slate-400 mb-2 text-center">Pipeline</p>
                            <div class="flex justify-between items-center text-center px-2">
                                <div class="flex flex-col">
                                    <span class="text-sm font-bold text-slate-800 dark:text-white">${stats.total}</span>
                                    <span class="text-[8px] uppercase font-semibold text-slate-500">Total</span>
                                </div>
                                <div class="w-px h-6 bg-slate-200 dark:bg-slate-700"></div>
                                <div class="flex flex-col">
                                    <span class="text-sm font-bold text-blue-500">${stats.active}</span>
                                    <span class="text-[8px] uppercase font-semibold text-slate-500">Active</span>
                                </div>
                                <div class="w-px h-6 bg-slate-200 dark:bg-slate-700"></div>
                                <div class="flex flex-col">
                                    <span class="text-sm font-bold text-emerald-500">${stats.hired}</span>
                                    <span class="text-[8px] uppercase font-semibold text-slate-500">Hired</span>
                                </div>
                                <div class="w-px h-6 bg-slate-200 dark:bg-slate-700"></div>
                                <div class="flex flex-col">
                                    <span class="text-sm font-bold text-blue-600">${cachedTalentPool.filter(c => c.jobId === j.id).length}</span>
                                    <span class="text-[8px] uppercase font-semibold text-blue-500">New</span>
                                </div>
                            </div>
                        </div>

                        <!-- Right: Actions -->
                        <div class="flex lg:flex-col justify-center gap-2 mt-4 lg:mt-0 lg:w-40 shrink-0">
                            <button onclick="addCandidateForJob('${j.id}', '${j.department || ''}')" class="flex-1 py-1.5 px-3 rounded-md bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-[11px] font-bold hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors text-slate-700 dark:text-slate-300 flex items-center justify-center gap-1.5"><i class="fas fa-user-plus"></i> Add</button>
                            <button onclick="viewJobInbox('${j.id}')" class="flex-1 py-1.5 px-3 rounded-md bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400 text-[11px] font-bold hover:bg-emerald-100 dark:hover:bg-emerald-800/40 transition-colors flex items-center justify-center gap-1.5"><i class="fas fa-inbox"></i> Inbox</button>
                            <button onclick="viewJobPipeline(this)" data-jobid="${j.id}" data-jobtitle="${j.title}" class="flex-1 py-1.5 px-3 rounded-md bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400 text-[11px] font-bold hover:bg-blue-100 dark:hover:bg-blue-800/40 transition-colors flex items-center justify-center gap-1.5"><i class="fas fa-route"></i> Pipeline</button>
                        </div>

                    </div>
                </div>
            `;
    }).join('');
}

function renderCompanies() {
    const container = document.getElementById('companies-list');
    const q = getEffectiveQuery('companies');
    const filtered = q ? cachedCompanies.filter(c => (c.name || '').toLowerCase().includes(q)) : cachedCompanies.slice();
    if (filtered.length === 0) {
        container.innerHTML = '<div class="text-slate-400 p-8 col-span-full text-center bg-slate-800/20 rounded-2xl border border-dashed border-slate-700">No companies found.</div>';
        return;
    }
    container.innerHTML = filtered.map(c => `
            <div class="glass-card p-0 rounded-2xl flex flex-col group overflow-hidden border border-slate-200 dark:border-slate-800 hover:border-blue-500/50 transition-all duration-300 shadow-sm hover:shadow-xl relative">
                    <div class="h-2 bg-gradient-to-r from-blue-500 to-indigo-600"></div>
                    <div class="p-6">
                        <div class="flex justify-between items-start mb-4">
                            <div class="flex items-center gap-3">
                                <div class="w-12 h-12 rounded-xl bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex items-center justify-center text-xl font-bold shadow-sm">
                                    ${c.name.charAt(0)}
                                </div>
                                <div class="overflow-hidden min-w-0 flex-1">
                                    <h4 class="text-lg font-bold truncate text-slate-800 dark:text-white pr-16">${highlight(c.name, q)}</h4>
                                    <p class="text-blue-500 text-[10px] uppercase tracking-widest font-bold">${highlight(c.industry || 'Industry', q)}</p>
                                </div>
                            </div>
                            <div class="absolute top-4 right-4 flex gap-1 shrink-0 bg-white/90 dark:bg-slate-900/90 p-1 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity border border-slate-100 dark:border-slate-800 shadow-sm z-10">
                                <button onclick="showCompanyProfile('${c.id}')" class="p-1.5 text-slate-400 hover:text-emerald-500 rounded transition-colors" title="View Profile"><i class="fas fa-eye text-sm"></i></button>
                                <button onclick="editCompany('${c.id}')" class="p-1.5 text-slate-400 hover:text-blue-500 rounded transition-colors" title="Edit Company"><i class="fas fa-edit text-sm"></i></button>
                                <button onclick="deleteDocById('companies', '${c.id}')" class="p-1.5 text-slate-400 hover:text-red-500 rounded transition-colors" title="Delete Company"><i class="fas fa-trash text-sm"></i></button>
                            </div>
                        </div>

                        <div class="space-y-3 mt-4">
                            <div class="flex items-start gap-3">
                                <i class="fas fa-map-location-dot mt-1 text-slate-400 dark:text-slate-500 text-xs"></i>
                                <div class="flex-1 min-w-0">
                                    <p class="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-tighter mb-0.5">Address</p>
                                    <p class="text-sm text-slate-700 dark:text-slate-300 leading-relaxed line-clamp-2">${highlight(c.address || c.location || 'No address provided', q)}</p>
                                </div>
                            </div>
                            
                            ${c.website ? `
                            <div class="flex items-center gap-3">
                                <i class="fas fa-globe text-slate-400 dark:text-slate-500 text-xs"></i>
                                <div class="flex-1 min-w-0">
                                    <a href="${c.website}" target="_blank" class="text-sm text-blue-600 dark:text-blue-400 hover:underline truncate block">
                                        ${highlight(c.website.replace(/^https?:\/\//, ''), q)}
                                    </a>
                                </div>
                            </div>` : ''}
                        </div>
                    </div>
                </div>
            `).join('');
}


function renderCandidates() {
    const filterBudget = document.getElementById('filter-budget').value;
    const filterStage = document.getElementById('filter-candidate-stage') ? document.getElementById('filter-candidate-stage').value : 'all';
    const filterDept = document.getElementById('filter-candidate-dept') ? document.getElementById('filter-candidate-dept').value : 'all';
    const filterExp = document.getElementById('filter-candidate-exp') ? document.getElementById('filter-candidate-exp').value : 'all';
    const filterNp = document.getElementById('filter-candidate-np') ? document.getElementById('filter-candidate-np').value : 'all';
    const filterSource = document.getElementById('filter-candidate-source') ? document.getElementById('filter-candidate-source').value : 'all';

    const tableBody = document.getElementById('candidates-table-body');
    const cardsContainer = document.getElementById('candidates-cards');
    const q = getEffectiveQuery('candidates');

    // shared filter logic
    const list = (function getFilteredCandidates() {
        let arr = cachedCandidates.filter(c => {
            const job = cachedJobs.find(j => j.id === c.jobId || j.title === c.jobId);
            const jobTitle = job ? job.title.toLowerCase() : (c.jobId || '').toLowerCase();
            const jobDept = job ? (job.department || '').toLowerCase() : '';

            // Search Filter
            const matchSearch = !q ||
                (c.name || '').toLowerCase().includes(q) ||
                (c.email || '').toLowerCase().includes(q) ||
                jobTitle.includes(q) ||
                (c.phone || '').toLowerCase().includes(q);

            if (!matchSearch) return false;

            // Stage Filter
            if (filterStage !== 'all' && c.stage !== filterStage) return false;

            // Department Filter
            if (filterDept !== 'all' && jobDept !== filterDept.toLowerCase()) return false;

            // Experience Filter
            const exp = Number(c.experience || 0);
            if (filterExp === 'fresh' && exp > 1) return false;
            if (filterExp === 'junior' && (exp <= 1 || exp > 3)) return false;
            if (filterExp === 'mid' && (exp <= 3 || exp > 7)) return false;
            if (filterExp === 'senior' && exp <= 7) return false;

            // Notice Period Filter
            const np = Number(c.noticePeriod || 0);
            if (filterNp === 'immediate' && np > 0) return false;
            if (filterNp === '15' && np > 15) return false;
            if (filterNp === '30' && np > 30) return false;
            if (filterNp === '60' && np > 60) return false;
            if (filterNp === '90' && np > 90) return false;

            // Source Filter
            if (filterSource !== 'all' && (c.source || 'Other') !== filterSource) return false;

            // Talent Pool Filter - Exclude from main board
            if (c.inTalentPool) return false;

            // Hired Filter - Exclude from main pipeline and move to Archive
            if (c.stage === 'Hired') return false;

            // Rejected / Inactive Filter - Move to Talent Pool Rejected section
            const rejectedStages = ['REJECTED', 'Rejected', 'Backed Out', 'Not Interested'];
            if (rejectedStages.includes(c.stage)) return false;

            return true;
        });

        // Budget Filter
        if (filterBudget !== 'all') {
            arr = arr.filter(c => {
                const job = cachedJobs.find(j => j.id === c.jobId);
                if (!job) return true;
                const jobBudget = job.budget ? Number(job.budget) : (job.budgetMax ? Number(job.budgetMax) : 0);
                const annualExpCTC = Number(c.expectedCTC || c.expectedSalary || 0) * 12;
                return filterBudget === 'within' ? annualExpCTC <= jobBudget : annualExpCTC > jobBudget;
            });
        }
        return arr;
    })();

    // quick empty state
    if (list.length === 0) {
        tableBody.innerHTML = `<tr > <td colspan="7" class="p-6 text-center text-slate-500">No candidates found.</td></tr> `;
        cardsContainer.innerHTML = `<div class="col-span-1 p-6 text-center text-slate-500" > No candidates found.</div> `;
        return;
    }

    // render table rows
    tableBody.innerHTML = list.map(c => {
        const job = cachedJobs.find(j => j.id === c.jobId);
        let budgetStatus = { label: 'Unknown', color: 'badge badge-gray' };

        let jobBudget = job ? (job.budget ? Number(job.budget) : (job.budgetMax ? Number(job.budgetMax) : 0)) : 0;
        let monthlyJobBudget = Math.round(jobBudget / 12);

        // Prioritize Final CTC for comparison, otherwise Expected CTC
        const CandidateMonthlyCTC = Number(c.offeredCTC || c.expectedCTC || 0);
        const annualCandCTC = CandidateMonthlyCTC * 12;

        if (job && jobBudget > 0) {
            const diffMonthly = CandidateMonthlyCTC - monthlyJobBudget;
            let diffText = '';
            if (diffMonthly > 0) {
                diffText = `(₹${diffMonthly.toLocaleString()} / mo Higher)`;
            } else if (diffMonthly < 0) {
                diffText = `(₹${Math.abs(diffMonthly).toLocaleString()} / mo Less)`;
            } else if (diffMonthly === 0 && CandidateMonthlyCTC > 0) {
                diffText = `(Exact Match)`;
            }

            if (annualCandCTC <= jobBudget) budgetStatus = { label: 'Within Budget', subText: diffText, color: 'badge badge-green' };
            else if (annualCandCTC <= jobBudget * 1.1) budgetStatus = { label: 'Slightly Above', subText: diffText, color: 'badge badge-orange' };
            else budgetStatus = { label: 'Over Budget', subText: diffText, color: 'badge badge-red' };
        }

        const initials = (c.name || '').split(' ').map(s => s[0]).join('').substring(0, 2).toUpperCase();

        return `
            <tr class="theme-tr transition group">
                        <td class="px-6 py-4">
                            <div class="font-medium flex items-center gap-3 text-slate-800 dark:text-white">
                                <div class="w-9 h-9 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-sm font-bold text-slate-700">${initials}</div>
                                <div>
                                    <div>${highlight(c.name, q)} <span class="bg-slate-100 dark:bg-slate-700/50 text-slate-600 dark:text-slate-300 text-[9px] px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-600 uppercase" title="Source: ${c.source || 'N/A'}">${c.source ? c.source.substring(0, 2) : 'N/A'}</span></div>
                                    <div class="text-xs text-slate-500 flex gap-2 items-center mt-1">
                                        <a href="mailto:${c.email}" class="hover:text-blue-500 dark:hover:text-blue-400 truncate w-32 inline-block"><i class="fas fa-envelope mr-1"></i>${highlight(c.email, q)}</a>
                                        <a href="https://wa.me/${c.phone ? c.phone.replace(/[^0-9]/g, '') : ''}" target="_blank" class="hover:text-whatsapp"><i class="fab fa-whatsapp mr-1"></i>${highlight(c.phone || 'N/A', q)}</a>
                                    </div>
                                </div>
                            </div>
                        </td>
                        <td class="px-6 py-4 text-sm border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/20">
                            <span class="text-slate-700 dark:text-slate-300 font-medium">${highlight(job ? job.title : 'Deleted Job', q)}</span>
                            ${job && job.designation ? `<div class="text-xs text-slate-500 font-normal">${highlight(job.designation, q)}</div>` : ''}
                        </td>
                        <td class="px-6 py-4 text-sm border-b border-slate-200 dark:border-slate-800">
                            <div class="text-slate-700 dark:text-slate-300 font-medium">${c.experience ? c.experience + ' Yrs' : 'N/A'}</div>
                            <div class="text-[10px] text-slate-500 mt-1">NP: <span class="text-blue-600 dark:text-blue-300 font-bold">${c.noticePeriod || 0}</span> days</div>
                        </td>
                        <td class="px-6 py-4 border-b border-slate-200 dark:border-slate-800">
                            <div class="text-sm font-semibold text-slate-800 dark:text-slate-300" title="Expected Monthly CTC">₹${c.expectedCTC ? parseInt(c.expectedCTC).toLocaleString() : '0'}<span class="text-[9px] font-normal text-slate-500">/mo</span> <span class="text-[10px] font-normal text-slate-500">(Exp)</span></div>
                            <div class="text-xs text-slate-500 mt-1" title="Current Monthly CTC">₹${c.currentCTC ? parseInt(c.currentCTC).toLocaleString() : 'N/A'}<span class="text-[8px]">/mo</span> <span class="text-[9px]">(Cur)</span></div>
                            ${c.offeredCTC ? `<div class="text-xs text-green-600 dark:text-green-400 mt-1 font-bold" title="Final Monthly CTC">₹${parseInt(c.offeredCTC).toLocaleString()}<span class="text-[8px] uppercase tracking-tighter">/mo</span> <span class="text-[8px] uppercase tracking-tighter">(Final)</span></div>` : ''}
                            ${job && monthlyJobBudget > 0 ? `<div class="text-[10px] text-blue-500 mt-1.5 font-medium border-t border-slate-100 dark:border-slate-800 pt-1" title="Job Monthly Budget">Max Budget: ₹${monthlyJobBudget.toLocaleString()}/mo</div>` : ''}
                        </td>
                        <td class="px-6 py-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/20">
                            <select onchange="updateCandidateStage('${c.id}', this.value)" class="filter-select compact text-xs">
                                <option ${c.stage === 'Applied' ? 'selected' : ''}>Applied</option>
                                <option ${c.stage === 'Screening' ? 'selected' : ''}>Screening</option>
                                <option ${c.stage === 'Interview' ? 'selected' : ''}>Interview</option>
                                <option ${c.stage === 'Selected' ? 'selected' : ''}>Selected</option>
                                <option ${c.stage === 'Hired' ? 'selected' : ''}>Hired</option>
                                <option ${c.stage === 'Rejected' ? 'selected' : ''}>Rejected</option>
                                <option ${c.stage === 'Backed Out' ? 'selected' : ''}>Backed Out</option>
                                <option ${c.stage === 'Not Interested' ? 'selected' : ''}>Not Interested</option>
                            </select>
                        </td>
                        <td class="px-6 py-4 text-center border-b border-slate-200 dark:border-slate-800">
                            <div class="flex flex-col items-center gap-1.5">
                                <span class="${budgetStatus.color} font-bold">${budgetStatus.label}</span>
                                ${budgetStatus.subText ? `<span class="text-[9px] font-bold text-slate-500 uppercase tracking-tight">${budgetStatus.subText}</span>` : ''}
                            </div>
                        </td>
                        <td class="px-6 py-4 text-right border-b border-slate-200 dark:border-slate-800">
                            <div class="flex gap-2 justify-end opacity-0 group-hover:opacity-100 transition">
                                <button onclick="showCandidateProfile('${c.id}')" class="p-2 text-slate-400 hover:text-emerald-500 dark:hover:text-emerald-400 bg-slate-100 dark:bg-slate-800/80 rounded shadow-sm" title="View Profile"><i class="fas fa-eye"></i></button>
                                ${c.resumeUrl ? `<button onclick="previewResume('${c.resumeUrl}')" class="p-2 text-blue-500 hover:text-blue-600 bg-blue-50 dark:bg-blue-900/30 rounded shadow-sm" title="View Resume Internally"><i class="fas fa-file-pdf"></i></button>` : ''}
                                <button onclick="toggleContactStatus('${c.id}')" class="p-2 text-${c.isContact ? 'amber' : 'blue'}-500 hover:text-${c.isContact ? 'amber' : 'blue'}-600 bg-${c.isContact ? 'amber' : 'blue'}-50 dark:bg-${c.isContact ? 'amber' : 'blue'}-900/30 rounded shadow-sm" title="${c.isContact ? 'Remove from contacts' : 'Save to contacts'}"><i class="fas ${c.isContact ? 'fa-user-minus' : 'fa-user-plus'}"></i></button>
                                <button onclick="editCandidate('${c.id}')" class="p-2 text-slate-400 hover:text-blue-500 dark:hover:text-blue-400 bg-slate-100 dark:bg-slate-800/80 rounded shadow-sm" title="Edit Profile"><i class="fas fa-edit"></i></button>
                                <button onclick="deleteDocById('candidates', '${c.id}')" class="p-2 text-slate-400 hover:text-red-500 dark:hover:text-red-400 bg-slate-100 dark:bg-slate-800/80 rounded shadow-sm" title="Delete Candidate"><i class="fas fa-trash-alt"></i></button>
                            </div>
                        </td>
                        </tr>
            `;
    }).join('');

    // render card view
    cardsContainer.innerHTML = list.map(c => {
        const job = cachedJobs.find(j => j.id === c.jobId);
        const initials = (c.name || '').split(' ').map(s => s[0]).join('').substring(0, 2).toUpperCase();
        let jobBudget = job ? (job.budget ? Number(job.budget) : (job.budgetMax ? Number(job.budgetMax) : 0)) : 0;
        let monthlyJobBudget = Math.round(jobBudget / 12);
        let budgetStatus = { label: 'Unknown', color: 'badge badge-gray' };
        if (job && jobBudget > 0) {
            const CandidateMonthlyCTC = Number(c.offeredCTC || c.expectedCTC || c.expectedSalary || 0);
            const annualCandCTC = CandidateMonthlyCTC * 12;
            const diffMonthly = CandidateMonthlyCTC - monthlyJobBudget;
            let diffText = '';
            if (diffMonthly > 0) {
                diffText = `(+₹${diffMonthly.toLocaleString()} / mo)`;
            } else if (diffMonthly < 0) {
                diffText = `(-₹${Math.abs(diffMonthly).toLocaleString()} / mo)`;
            }

            if (annualCandCTC <= jobBudget) budgetStatus = { label: 'Within Budget', subText: diffText, color: 'badge badge-green' };
            else if (annualCandCTC <= jobBudget * 1.1) budgetStatus = { label: 'Slightly Above', subText: diffText, color: 'badge badge-orange' };
            else budgetStatus = { label: 'Over Budget', subText: diffText, color: 'badge badge-red' };
        }
        return `
            <div class="glass-card p-4 rounded-xl">
                    <div class="flex items-start justify-between">
                        <div class="flex items-center gap-3">
                            <div class="w-12 h-12 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center font-bold text-slate-700">${initials}</div>
                            <div>
                                <div class="font-bold text-slate-800 dark:text-white">${highlight(c.name, q)}</div>
                                <div class="text-sm text-slate-500">${job ? job.title : 'No Job'}</div>
                            </div>
                        </div>
                        <div class="text-right">
                            <div class="text-sm font-semibold">₹${c.expectedCTC ? parseInt(c.expectedCTC).toLocaleString() : '0'}${c.offeredCTC ? ' <span class="text-[9px] text-green-500 font-bold">(Final)</span>' : ''}</div>
                            <div class="text-[10px] text-blue-500 font-medium">Budget: ${monthlyJobBudget > 0 ? '₹' + monthlyJobBudget.toLocaleString() + '/mo' : 'N/A'}</div>
                            <div class="text-xs text-slate-500 mt-1">${c.experience ? c.experience + ' Yrs' : 'N/A'}</div>
                        </div>
                    </div>
                    <div class="flex items-center justify-between mt-3">
                        <div class="flex items-center gap-2">
                            <button onclick="showCandidateProfile('${c.id}')" class="px-3 py-1 rounded bg-emerald-50 text-emerald-600 hover:bg-emerald-100 flex items-center gap-1 text-xs"><i class="fas fa-eye text-[10px]"></i> View</button>
                            ${c.resumeUrl ? `<button onclick="previewResume('${c.resumeUrl}')" class="px-3 py-1 rounded bg-blue-50 text-blue-600 hover:bg-blue-100 flex items-center gap-1 text-xs"><i class="fas fa-file-pdf text-[10px]"></i> CV</button>` : ''}
                            <button onclick="editCandidate('${c.id}')" class="px-3 py-1 rounded bg-slate-100 hover:bg-slate-200 text-xs text-slate-600">Edit</button>
                            <button onclick="deleteDocById('candidates', '${c.id}')" class="px-3 py-1 rounded bg-red-50 hover:bg-red-100 text-red-600 text-xs">Delete</button>
                        </div>
                        <div class="flex flex-col items-end">
                            <div class="text-[10px] uppercase font-bold tracking-wider ${budgetStatus.color.includes('green') ? 'text-green-500' : (budgetStatus.color.includes('orange') ? 'text-orange-500' : (budgetStatus.color.includes('red') ? 'text-red-500' : 'text-slate-400'))}">${budgetStatus.label}</div>
                            ${budgetStatus.subText ? `<div class="text-[8px] font-bold text-slate-500 uppercase tracking-tight mt-0.5">${budgetStatus.subText}</div>` : ''}
                        </div>
                    </div>
                </div>
            `;
    }).join('');

    // toggle view visibility
    const cardsEl = document.getElementById('candidates-cards');
    const tableEl = document.getElementById('candidates-table');
    if (candidateView === 'cards') {
        cardsEl.classList.remove('hidden');
        tableEl.classList.add('hidden');
    } else {
        cardsEl.classList.add('hidden');
        tableEl.classList.remove('hidden');
    }
    // Ensure any newly created select elements are converted to custom selects
    try { initCustomSelects(); } catch (e) { console.warn('initCustomSelects after renderCandidates failed', e); }
}

function renderArchive() {
    const container = document.getElementById('archive-list');
    if (!container) return;

    if (currentArchiveTab === 'candidates') {
        renderArchivedCandidates(container);
    } else {
        renderArchivedJobs(container);
    }
}

function renderArchivedCandidates(container) {
    const list = cachedCandidates.filter(c => c.stage === 'Hired');
    if (list.length === 0) {
        container.innerHTML = `
            <div class="col-span-full py-20 flex flex-col items-center justify-center text-slate-400 bg-slate-50/50 dark:bg-slate-900/20 rounded-3xl border-2 border-dashed border-slate-200 dark:border-slate-800">
                <i class="fas fa-users text-4xl mb-4 opacity-20"></i>
                <p class="font-medium">No successful placements yet</p>
                <p class="text-xs mt-1">Candidates marked as "Hired" appear here.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = list.map(c => {
        const job = cachedJobs.find(j => j.id === c.jobId);
        const initials = (c.name || '').split(' ').map(s => s[0]).join('').substring(0, 2).toUpperCase();
        const hiredDate = c.hiredAt ? new Date(c.hiredAt.seconds * 1000).toLocaleDateString() : (c.updatedAt ? new Date(c.updatedAt.seconds * 1000).toLocaleDateString() : 'N/A');

        return `
            <div class="glass-card hover:bg-slate-50 dark:hover:bg-slate-800/40 p-3 rounded-xl border border-slate-200 dark:border-white/5 transition-all">
                <div class="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div class="flex items-center gap-3 flex-1 min-w-0">
                        <div class="w-9 h-9 rounded-lg bg-amber-50 dark:bg-amber-900/20 flex items-center justify-center text-amber-600 font-black text-xs shadow-inner shrink-0">
                            ${initials}
                        </div>
                        <div class="min-w-0">
                            <h3 class="font-bold text-slate-800 dark:text-white leading-tight truncate text-sm">${c.name}</h3>
                            <p class="text-[9px] font-bold text-slate-400 uppercase tracking-tight truncate">${job ? job.title : 'Deleted Position'}</p>
                        </div>
                    </div>
                    
                    <div class="flex items-center gap-6 shrink-0">
                        <div class="flex flex-col items-center">
                            <span class="text-[8px] font-black text-slate-400 uppercase tracking-widest">Hired</span>
                            <span class="text-[10px] font-bold text-slate-600 dark:text-slate-200 mt-0.5">${hiredDate}</span>
                        </div>
                        <div class="flex flex-col items-center">
                            <span class="text-[8px] font-black text-slate-400 uppercase tracking-widest">CTC</span>
                            <span class="text-[10px] font-bold text-emerald-600 mt-0.5">₹${c.offeredCTC ? parseInt(c.offeredCTC).toLocaleString() : 'TBD'}</span>
                        </div>
                    </div>

                    <div class="flex items-center gap-1.5 shrink-0">
                        <button onclick="showCandidateProfile('${c.id}')" class="px-3 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-[9px] font-bold border border-slate-200 dark:border-slate-700 hover:bg-slate-100 transition-all flex items-center gap-1.5">
                            <i class="fas fa-user-circle"></i>Profile
                        </button>
                        <button onclick="updateCandidateStage('${c.id}', 'Interview')" class="w-8 h-8 flex items-center justify-center rounded-lg bg-slate-50 dark:bg-slate-800 text-slate-400 hover:text-amber-500 hover:border-amber-400 border border-slate-200 dark:border-slate-700 transition-all" title="Restore back to Pipeline">
                            <i class="fas fa-rotate-left text-[10px]"></i>
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function renderArchivedJobs(container) {
    const list = cachedJobs.filter(j => j.status === 'Closed');
    if (list.length === 0) {
        container.innerHTML = `
            <div class="col-span-full py-20 flex flex-col items-center justify-center text-slate-400 bg-slate-50/50 dark:bg-slate-900/20 rounded-3xl border-2 border-dashed border-slate-200 dark:border-slate-800">
                <i class="fas fa-briefcase text-4xl mb-4 opacity-20"></i>
                <p class="font-medium">No archived positions</p>
                <p class="text-xs mt-1">Jobs marked as "Closed" will appear here automatically.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = list.map(j => {
        const candidatesForJob = cachedCandidates.filter(c => c.jobId === j.id);
        const hiredCount = candidatesForJob.filter(c => c.stage === 'Hired').length;

        return `
            <div class="glass-card hover:bg-slate-50 dark:hover:bg-slate-800/40 p-3 rounded-xl border border-slate-200 dark:border-white/5 transition-all">
                <div class="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div class="flex-1 min-w-0">
                        <h3 class="font-bold text-slate-800 dark:text-white leading-tight truncate text-sm">${j.title}</h3>
                        <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest truncate">${j.department || 'General'}</p>
                    </div>

                    <div class="flex items-center gap-6 shrink-0">
                        <div class="flex flex-col items-center">
                            <span class="text-[8px] font-black text-slate-400 uppercase tracking-widest">Candidates</span>
                            <span class="text-[10px] font-bold text-slate-700 dark:text-white mt-0.5">${candidatesForJob.length}</span>
                        </div>
                        <div class="flex flex-col items-center">
                            <span class="text-[8px] font-black text-slate-400 uppercase tracking-widest">Success</span>
                            <span class="text-[10px] font-bold text-emerald-500 mt-0.5">${hiredCount}</span>
                        </div>
                        <div class="flex flex-col items-center">
                            <span class="text-[8px] font-black text-slate-400 uppercase tracking-widest">Status</span>
                            <span class="text-[9px] font-black text-red-500/80 mt-0.5 underline decoration-dotted">CLOSED</span>
                        </div>
                    </div>

                    <div class="flex gap-2 shrink-0">
                        <button onclick="editJob('${j.id}')" class="px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-[9px] font-bold border border-slate-200 dark:border-slate-700 hover:bg-slate-200 transition-all flex items-center gap-2 whitespace-nowrap">
                            <i class="fas fa-edit"></i> REOPEN
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function exportArchiveCSV() {
    const list = cachedCandidates.filter(c => c.stage === 'Hired');
    if (list.length === 0) { showToast("No archived candidates to export."); return; }

    const rows = [];
    const headers = ['Name', 'Email', 'Phone', 'Position', 'Hired Date', 'Monthly CTC', 'Annual CTC'];
    rows.push(headers.join(','));

    list.forEach(c => {
        const job = cachedJobs.find(j => j.id === c.jobId);
        const hiredDate = c.hiredAt ? new Date(c.hiredAt.seconds * 1000).toLocaleDateString() : 'N/A';
        const monthly = c.offeredCTC || 0;
        const annual = monthly * 12;

        const vals = [
            c.name || '',
            c.email || '',
            c.phone || '',
            job ? job.title : '',
            hiredDate,
            monthly,
            annual
        ];
        rows.push(vals.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(','));
    });

    const csv = rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'hired_archive_export.csv'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

function renderInterviews() {
    const container = document.getElementById('interviews-list');
    const q = getEffectiveQuery('interviews');
    const qnorm = q ? q.toLowerCase() : '';

    // 1. Filter interviews
    let filtered = cachedInterviews.filter(i => {
        const cand = cachedCandidates.find(c => c.id === i.candidateId);
        if (!cand) return false;
        if (!qnorm) return true;
        const job = cachedJobs.find(j => j.id === cand.jobId);
        return cand.name.toLowerCase().includes(qnorm) ||
            (i.interviewer && i.interviewer.toLowerCase().includes(qnorm)) ||
            (job && job.title.toLowerCase().includes(qnorm)) ||
            (cand.phone && cand.phone.replace(/[^0-9]/g, '').includes(qnorm.replace(/[^0-9]/g, '')));
    });

    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="col-span-full py-20 flex flex-col items-center justify-center text-slate-400 bg-slate-50/50 dark:bg-slate-900/20 rounded-3xl border-2 border-dashed border-slate-200 dark:border-slate-800">
                <i class="fa-solid fa-calendar-xmark text-4xl mb-4 opacity-20"></i>
                <p class="font-medium">No interviews matching your search</p>
            </div>`;
        return;
    }

    // 2. Sort by date Descending (Latest on top)
    filtered.sort((a, b) => new Date(b.dateTime || 0) - new Date(a.dateTime || 0));

    // 3. Group by date
    const groups = {};
    filtered.forEach(i => {
        const dateKey = i.dateTime ? i.dateTime.split('T')[0] : 'TBD';
        if (!groups[dateKey]) groups[dateKey] = [];
        groups[dateKey].push(i);
    });

    // 4. Render
    let html = '';
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    Object.keys(groups).sort().reverse().forEach(dateKey => {
        let label = dateKey;
        if (dateKey === todayStr) label = "Today";
        else if (dateKey === tomorrowStr) label = "Tomorrow";
        else if (dateKey !== 'TBD') label = new Date(dateKey).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

        html += `<div class="date-divider"><span>${label}</span></div>`;

        groups[dateKey].forEach(i => {
            const cand = cachedCandidates.find(c => c.id === i.candidateId);
            const job = cand ? cachedJobs.find(j => j.id === cand.jobId) : null;
            const company = job ? cachedCompanies.find(co => co.id === job.companyId) : null;

            const dt = i.dateTime ? new Date(i.dateTime) : null;
            const time = dt ? dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'TBD';
            const day = dt ? dt.getDate() : '--';
            const month = dt ? dt.toLocaleString('default', { month: 'short' }) : '---';

            const status = i.status || 'Scheduled';
            let badgeClass = 'badge badge-blue';
            if (['Done', 'Interviewed'].includes(status)) badgeClass = 'badge badge-gray';
            if (status === 'Selected') badgeClass = 'badge badge-green';
            if (['Rejected', 'Backed Out', 'Not Interested'].includes(status)) badgeClass = 'badge badge-red';

            const isLive = dt && Math.abs(dt - now) < (30 * 60 * 1000) && status === 'Scheduled';

            html += `
                <div class="interview-row group">
                    <div class="interview-date-col">
                        <span class="date-day">${day}</span>
                        <span class="date-month">${month}</span>
                        <span class="text-[10px] font-bold text-slate-400 mt-1">${time}</span>
                    </div>
                    
                    <div class="interview-main-col">
                        <div class="flex items-center gap-3 mb-1">
                            <h4 class="interview-candidate-name">${highlight(cand ? cand.name : 'Unknown', q)}</h4>
                            <span class="${badgeClass}">${status}</span>
                            ${isLive ? '<span class="indicator-live" title="Starting Soon / Live"></span>' : ''}
                        </div>
                        <div class="interview-job-info">
                            <span class="text-blue-500"><i class="fas fa-briefcase"></i> ${job ? job.title : 'N/A'}</span>
                            <span class="text-slate-300">•</span>
                            <span><i class="fas fa-building text-slate-400"></i> ${company ? company.name : 'N/A'}</span>
                        </div>
                        <div class="mt-2 flex items-center gap-2">
                             <span class="text-[9px] px-1.5 py-0.5 bg-slate-100 dark:bg-slate-800 rounded font-bold text-slate-500 uppercase tracking-tighter border border-slate-200 dark:border-slate-700">
                                ${i.round || 'Initial Round'}
                             </span>
                        </div>
                    </div>

                    <div class="interview-meta-col flex flex-col gap-1 text-[11px]">
                        <div class="flex items-center gap-2">
                            <i class="fas fa-user-tie text-slate-400"></i>
                            <span class="font-medium">${i.interviewer || 'TBD'}</span>
                        </div>
                        <div class="flex items-center gap-2">
                            <i class="fas ${i.mode && i.mode.includes('Video') ? 'fa-video text-blue-500' : 'fa-map-marker-alt text-orange-500'}"></i>
                            <span class="${i.mode && i.mode.includes('Video') ? 'text-blue-600 dark:text-blue-400 font-bold' : ''}">${i.mode || 'Location TBD'}</span>
                        </div>
                    </div>

                    <div class="interview-actions-col">
                        ${i.meetingLink ? `
                        <a href="${i.meetingLink}" target="_blank" class="btn-action-round text-emerald-500 hover:text-white" title="Join Meeting">
                            <i class="fas fa-video"></i>
                        </a>` : ''}
                        
                        <button onclick="previewResume('${cand ? cand.resumeUrl : ''}')" class="btn-action-round" title="View Resume">
                            <i class="fas fa-file-pdf text-blue-500"></i>
                        </button>
                        
                        <button onclick="editInterview('${i.id}')" class="btn-action-round hover:bg-slate-500" title="Manage & Feedback">
                             <i class="fas fa-comment-dots"></i>
                        </button>

                        <button onclick="deleteDocById('interviews', '${i.id}')" class="btn-action-round hover:bg-red-500" title="Cancel/Delete">
                             <i class="fas fa-times-circle text-red-400 group-hover:text-white"></i>
                        </button>
                    </div>
                </div>
            `;
        });
    });

    container.innerHTML = html;
}

// --- DASHBOARD ANALYTICS ---
let stageChartInstance, budgetChartInstance, sourceChartInstance;
function updateDashboard() {
    // Basic Counters
    const totalCandidates = cachedCandidates.length;
    const activeJobs = cachedJobs.filter(j => j.status === 'Open').length;
    document.getElementById('stat-total-candidates').innerText = totalCandidates;
    document.getElementById('stat-active-jobs').innerText = activeJobs || cachedJobs.length;

    // Today's Interviews
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const todayInts = cachedInterviews.filter(i => i.dateTime && i.dateTime.startsWith(todayStr)).length;
    document.getElementById('stat-today-interviews').innerText = todayInts;



    // Talent Pool
    const talentPool = cachedCandidates.filter(c => c.stage !== 'Hired' && c.stage !== 'Rejected' && c.stage !== 'Backed Out' && c.stage !== 'Not Interested').length;
    const tpEl = document.getElementById('stat-talent-pool');
    if (tpEl) tpEl.innerText = talentPool;

    // Total Hires
    const hiredCount = cachedCandidates.filter(c => c.stage === 'Hired').length;
    const thEl = document.getElementById('stat-total-hires');
    if (thEl) thEl.innerText = hiredCount;

    // Essential Metrics for Charts and Dashboard
    let withinBudgetCount = 0;
    let totalCandWithJob = 0;
    let ctcs = [];
    const sourceMap = {};

    cachedCandidates.forEach(c => {
        const job = cachedJobs.find(j => j.id === c.jobId);
        const expCTC = Number(c.expectedCTC || c.expectedSalary || 0);
        const annualExpCTC = expCTC * 12;
        if (expCTC > 0) ctcs.push(expCTC);

        if (job) {
            let jobBudget = job.budget ? Number(job.budget) : (job.budgetMax ? Number(job.budgetMax) : 0);
            if (jobBudget > 0 && annualExpCTC > 0) {
                totalCandWithJob++;
                if (annualExpCTC <= jobBudget) withinBudgetCount++;
            }
        }

        const s = c.source || 'Other';
        sourceMap[s] = (sourceMap[s] || 0) + 1;
    });

    const adherence = totalCandWithJob > 0 ? Math.round((withinBudgetCount / totalCandWithJob) * 100) : 100;
    const sortedSources = Object.entries(sourceMap).sort((a, b) => b[1] - a[1]);
    // Statistics for legacy elements if they still exist
    const selectedCount = cachedCandidates.filter(c => c.stage === 'Selected' || c.stage === 'Hired').length;
    const selectionRate = totalCandidates > 0 ? Math.round((selectedCount / totalCandidates) * 100) : 0;
    const srLegacy = document.getElementById('stat-selection-rate');
    if (srLegacy) srLegacy.innerText = selectionRate + '%';

    const bLegacy = document.getElementById('stat-avg-budget');
    if (bLegacy) {
        bLegacy.innerText = adherence + '%';
        bLegacy.className = `text-xl font-bold mt-1 ${adherence >= 80 ? 'text-green-500' : adherence >= 50 ? 'text-orange-500' : 'text-red-500'}`;
    }

    // Median CTC
    ctcs.sort((a, b) => a - b);
    let median = 0;
    if (ctcs.length > 0) {
        const mid = Math.floor(ctcs.length / 2);
        median = ctcs.length % 2 !== 0 ? ctcs[mid] : (ctcs[mid - 1] + ctcs[mid]) / 2;
    }
    const medianAnnual = median * 12;
    const medianEl = document.getElementById('stat-median-ctc');
    if (medianEl) medianEl.innerText = medianAnnual ? `₹${(medianAnnual / 100000).toFixed(1)} L` : '₹0';

    // Monthly Hires
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();
    const monthlyHires = cachedCandidates.filter(c => {
        if (c.stage !== 'Hired') return false;
        const timestamp = c.hiredAt || c.createdAt;
        if (!timestamp) return false;
        const d = (timestamp.seconds) ? new Date(timestamp.seconds * 1000) : new Date(timestamp);
        return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
    }).length;
    const mhEl = document.getElementById('stat-monthly-hires-big');
    if (mhEl) mhEl.innerText = monthlyHires;


    // Interview Stats

    const upcomingInts = cachedInterviews.filter(i => i.dateTime && new Date(i.dateTime) >= now).length;
    const pendingFeedback = cachedInterviews.filter(i => (i.status === 'Interviewed' || i.status === 'Done') && !i.feedback).length;
    const completedToday = cachedInterviews.filter(i => {
        if (!i.dateTime) return false;
        const d = new Date(i.dateTime);
        return d.toDateString() === now.toDateString() && (i.status === 'Done' || i.status === 'Interviewed');
    }).length;

    const statUpcomingEl = document.getElementById('stat-int-upcoming');
    if (statUpcomingEl) statUpcomingEl.innerText = upcomingInts;
    const statPendingFeedbackEl = document.getElementById('stat-int-pending');
    if (statPendingFeedbackEl) statPendingFeedbackEl.innerText = pendingFeedback;
    const statCompletedTodayEl = document.getElementById('stat-int-completed');
    if (statCompletedTodayEl) statCompletedTodayEl.innerText = completedToday;

    // Join Ratio
    const selectedOf = cachedCandidates.filter(c => c.stage === 'Selected').length;
    const joinRatio = (hiredCount + selectedOf) > 0 ? Math.round((hiredCount / (hiredCount + selectedOf)) * 100) : 0;
    const jrEl = document.getElementById('stat-join-ratio');
    if (jrEl) jrEl.innerText = joinRatio + '%';

    // Charts update
    if (stageChartInstance) stageChartInstance.destroy();
    const stages = ['Applied', 'Screening', 'Interview', 'Selected', 'Hired', 'Rejected', 'Backed Out', 'Not Interested'];
    const stageCounts = stages.map(s => cachedCandidates.filter(c => c.stage === s).length);
    stageChartInstance = new Chart(document.getElementById('stageChart'), {
        type: 'bar',
        data: {
            labels: stages,
            datasets: [{
                label: 'Candidates',
                data: stageCounts,
                backgroundColor: ['#3b82f6', '#8b5cf6', '#f59e0b', '#10b981', '#25D366', '#ef4444', '#64748b', '#94a3b8'],
                borderRadius: 8
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: { beginAtZero: true, grid: { color: 'rgba(51, 65, 85, 0.1)', borderDash: [5, 5] }, ticks: { font: { size: 10 } } },
                x: { grid: { display: false }, ticks: { font: { size: 10, weight: 'bold' } } }
            }
        }
    });

    if (sourceChartInstance) sourceChartInstance.destroy();
    const topSources = sortedSources.slice(0, 5);
    const otherCount = sortedSources.slice(5).reduce((acc, curr) => acc + curr[1], 0);
    sourceChartInstance = new Chart(document.getElementById('sourceChart'), {
        type: 'doughnut',
        data: {
            labels: [...topSources.map(s => s[0]), ...(otherCount > 0 ? ['Other'] : [])],
            datasets: [{
                data: [...topSources.map(s => s[1]), ...(otherCount > 0 ? [otherCount] : [])],
                backgroundColor: ['#3b82f6', '#8b5cf6', '#f59e0b', '#10b981', '#ef4444', '#94a3b8'],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '70%',
            plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } }
        }
    });

    if (budgetChartInstance) budgetChartInstance.destroy();
    const recentJobs = cachedJobs.slice(0, 6);
    budgetChartInstance = new Chart(document.getElementById('budgetChart'), {
        type: 'line',
        data: {
            labels: recentJobs.map(j => j.title.length > 15 ? j.title.substring(0, 12) + '...' : j.title),
            datasets: [
                { label: 'Budget', data: recentJobs.map(j => (j.budget || 0)), borderColor: '#10b981', backgroundColor: 'rgba(16, 185, 129, 0.1)', fill: true, tension: 0.4 },
                {
                    label: 'Avg Exp', data: recentJobs.map(j => {
                        const cands = cachedCandidates.filter(c => c.jobId === j.id);
                        return cands.length > 0 ? (cands.reduce((a, b) => a + Number(b.expectedCTC || 0), 0) / cands.length) * 12 : 0;
                    }), borderColor: '#ef4444', borderDash: [5, 5], tension: 0.4
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'top', labels: { boxWidth: 15, font: { size: 11 } } } },
            scales: { y: { grid: { color: 'rgba(51, 65, 85, 0.1)' }, ticks: { callback: (v) => '₹' + (v / 100000).toFixed(1) + 'L' } } }
        }
    });

    renderUpcomingInterviews();

    renderDashboardOffers();
    renderHiringFunnel();

    if (typeof refreshNotificationBadge === 'function') refreshNotificationBadge();

    const pendingOffers = cachedOffers.filter(o => !o.status || o.status === 'Pending' || o.status === 'Sent');
    const signedOffers = cachedOffers.filter(o => o.status === 'Signed' || o.status === 'Accepted');
    const ooEl2 = document.getElementById('stat-open-offers');
    if (ooEl2) ooEl2.innerText = pendingOffers.length;
    const signedEl = document.getElementById('stat-offers-signed');
    if (signedEl) signedEl.innerText = signedOffers.length;

    const expValues = cachedCandidates.map(c => Number(c.experience || 0)).filter(v => v > 0);
    const avgExp = expValues.length > 0 ? (expValues.reduce((a, b) => a + b, 0) / expValues.length).toFixed(1) : 0;
    const aeEl = document.getElementById('stat-avg-exp');
    if (aeEl) aeEl.innerText = avgExp;

}

// ── Pending Offers sidebar widget ──
function renderDashboardOffers() {
    const container = document.getElementById('dashboard-offers-list');
    const countEl = document.getElementById('pending-offers-count');
    if (!container) return;

    const pending = cachedOffers.filter(o => !o.status || o.status === 'Pending' || o.status === 'Sent');
    if (countEl) countEl.innerText = pending.length;

    if (pending.length === 0) {
        container.innerHTML = `<div class="text-center py-6 text-slate-400">
            <i class="fas fa-check-circle text-2xl mb-2 opacity-20"></i>
            <p class="text-xs">No pending offers.</p>
        </div>`;
        return;
    }

    container.innerHTML = pending.slice(0, 5).map(o => {
        const cand = cachedCandidates.find(c => c.id === o.candidateId);
        const ctc = o.offeredCTC ? `₹${Number(o.offeredCTC).toLocaleString('en-IN')}/mo` : '';
        return `<div class="flex items-center justify-between p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/50 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 cursor-pointer transition-colors" onclick="showSection('offers')">
            <div class="flex items-center gap-2.5 min-w-0">
                <div class="w-7 h-7 rounded-lg bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 flex items-center justify-center text-xs font-bold flex-shrink-0">
                    ${(cand?.name || o.candidateName || '?')[0].toUpperCase()}
                </div>
                <div class="min-w-0">
                    <p class="text-xs font-bold truncate">${cand?.name || o.candidateName || 'Unknown'}</p>
                    ${ctc ? `<p class="text-[10px] text-emerald-600 font-semibold">${ctc}</p>` : ''}
                </div>
            </div>
            <span class="text-[9px] font-bold uppercase px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 flex-shrink-0">${o.status || 'Pending'}</span>
        </div>`;
    }).join('');
    if (pending.length > 5) {
        container.innerHTML += `<p class="text-[10px] text-center text-slate-400 font-semibold pt-1">+${pending.length - 5} more</p>`;
    }
}

// ── Hiring Funnel widget ──
function renderHiringFunnel() {
    const container = document.getElementById('hiring-funnel-chart');
    if (!container) return;

    const funnelStages = [
        { label: 'Applied', color: '#3b82f6' },
        { label: 'Screening', color: '#8b5cf6' },
        { label: 'Interview', color: '#f59e0b' },
        { label: 'Selected', color: '#10b981' },
        { label: 'Offer', color: '#06b6d4' },
        { label: 'Hired', color: '#22c55e' },
    ];

    const counts = funnelStages.map(s => ({
        ...s,
        count: cachedCandidates.filter(c => c.stage === s.label).length
    }));

    // Also count stages that don't map 1:1
    const screeningAliases = ['Screening', 'Phone Screen', 'HR Screen'];
    const interviewAliases = ['Interview', 'L1 Interview', 'L2 Interview', 'Technical', 'Final Round'];
    counts[1].count = cachedCandidates.filter(c => screeningAliases.includes(c.stage)).length;
    counts[2].count = cachedCandidates.filter(c => interviewAliases.includes(c.stage)).length;

    const maxCount = Math.max(...counts.map(s => s.count), 1);

    container.innerHTML = counts.map(s => {
        const pct = Math.round((s.count / maxCount) * 100);
        const drop = s.count > 0 ? '' : 'opacity-40';
        return `<div class="flex items-center gap-3 ${drop}">
            <span class="text-[10px] font-bold text-slate-500 w-24 text-right flex-shrink-0">${s.label}</span>
            <div class="flex-1 h-7 bg-slate-100 dark:bg-slate-800 rounded-lg overflow-hidden">
                <div class="h-full rounded-lg flex items-center px-2 transition-all duration-500"
                     style="width:${pct || 2}%; background:${s.color};">
                    ${s.count > 0 ? `<span class="text-[10px] font-bold text-white ml-auto">${s.count}</span>` : ''}
                </div>
            </div>
            <span class="text-[10px] font-bold text-slate-400 w-6 flex-shrink-0">${pct}%</span>
        </div>`;
    }).join('');
}

function renderUpcomingInterviews() {
    const container = document.getElementById('dashboard-interviews-list');
    const q = getEffectiveQuery('interviews');
    const now = new Date();
    const futureInts = cachedInterviews
        .filter(i => i.dateTime && new Date(i.dateTime) >= now)
        .sort((a, b) => new Date(a.dateTime) - new Date(b.dateTime));

    document.getElementById('upcoming-count').innerText = `${futureInts.length} Scheduled`;

    if (futureInts.length === 0) {
        container.innerHTML = `
            <div class="flex flex-col items-center justify-center py-12 text-slate-400" >
                        <i class="fas fa-calendar-day text-4xl mb-4 opacity-20"></i>
                        <p class="text-sm">No upcoming interviews</p>
                    </div> `;
        return;
    }

    container.innerHTML = futureInts.slice(0, 10).map((i, index) => {
        const cand = cachedCandidates.find(c => c.id === i.candidateId);
        const job = cand ? cachedJobs.find(j => j.id === cand.jobId) : null;
        const dt = new Date(i.dateTime);
        const timeStr = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const dateStr = dt.toLocaleDateString([], { day: 'numeric', month: 'short' });
        const staggerClass = index < 6 ? `animate-fade-up stagger-${(index % 5) + 1}` : '';

        return `
            <div class="p-4 rounded-xl bg-white dark:bg-slate-800/40 border border-slate-100 dark:border-slate-800 hover:border-blue-500/30 transition-colors group hover-lift ${staggerClass}">
                <div class="flex justify-between items-start">
                    <div class="flex items-center gap-3">
                        <div class="flex flex-col items-center justify-center w-12 h-12 rounded-lg bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 font-bold">
                            <span class="text-[10px] uppercase leading-none">${dt.toLocaleString('default', { month: 'short' })}</span>
                            <span class="text-lg leading-none mt-1">${dt.getDate()}</span>
                        </div>
                        <div>
                            <p class="font-bold text-slate-800 dark:text-white group-hover:text-blue-500 transition-colors">${highlight(cand ? cand.name : 'Unknown', q)}</p>
                            <p class="text-xs text-slate-500 truncate w-32">${job ? job.title : 'Position'}</p>
                        </div>
                    </div>
                    <div class="text-right">
                        <p class="text-sm font-bold text-slate-700 dark:text-slate-300">${timeStr}</p>
                        <span class="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">${i.mode || 'Online'}</span>
                    </div>
                </div>
            </div>`;
    }).join('');
}



// --- FORMS & ACTIONS ---
document.getElementById('form-company').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const orig = btn.innerText; btn.innerText = "Saving..."; btn.disabled = true;
    try {
        const formData = new FormData(e.target);
        const data = Object.fromEntries(formData.entries());

        const editId = data.id;
        delete data.id;

        if (editId) {
            await updateDoc(doc(db, "companies", editId), data);
            showToast("Company Updated!");
        } else {
            data.createdAt = serverTimestamp();
            await addDoc(collection(db, "companies"), data);
            showToast("Company Added!");
        }

        document.getElementById('modal-company').classList.add('hidden');

        e.target.reset();
        document.getElementById('form-company-id').value = '';
    } catch (e) { alert("Error: " + e.message); }
    finally { btn.innerText = orig; btn.disabled = false; }
};

window.editCompany = (id) => {
    const current = cachedCompanies.find(c => c.id === id);
    if (!current) return;
    const form = document.getElementById('form-company');
    form.reset();
    for (const key in current) {
        if (form.elements[key]) form.elements[key].value = current[key];
    }

    // Update Workspace UI
    document.getElementById('comp-name-display').innerText = current.name || 'New Partner';
    document.getElementById('comp-industry-display').innerText = current.industry || 'Sector Unassigned';
    document.getElementById('comp-logo-display').innerHTML = current.name ? current.name.charAt(0).toUpperCase() : '<i class="fas fa-city"></i>';

    document.getElementById('form-company-id').value = id;
    document.getElementById('modal-company-title').innerText = "Edit Company Profile";
    openModal('modal-company');
};

document.getElementById('form-job').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const orig = btn.innerText; btn.innerText = "Saving..."; btn.disabled = true;
    try {
        const formData = new FormData(e.target);
        const data = Object.fromEntries(formData.entries());

        // Keep budget numeric and convert LPA to Full INR for Firestore compatibility
        data.budget = Number(data.budget) * 100000;

        // Parse multi-line fields into arrays
        if (data.requirements) {
            data.requirements = data.requirements.split('\n').map(s => s.trim()).filter(s => s !== '');
        } else {
            data.requirements = [];
        }

        // keySkills (Recruit) -> skills (Candidate) compatibility
        if (data.keySkills) {
            data.keySkills = data.keySkills.split('\n').map(s => s.trim()).filter(s => s !== '');
            data.skills = data.keySkills; // Duplicate for candidate portal
        } else {
            data.keySkills = [];
            data.skills = [];
        }

        const editId = data.id;
        delete data.id; // clear so it doesn't get saved as a field

        if (editId) {
            // Status logic for Edit
            if (data.status !== 'Draft') {
                if (data.status === 'Closed') {
                    // explicit close
                } else if (data.status === 'Open' && data.closingDate) {
                    const closeDate = new Date(data.closingDate);
                    closeDate.setHours(23, 59, 59, 999);
                    if (new Date() > closeDate) data.status = 'Closed';
                }
            }

            await updateDoc(doc(db, "jobs", editId), data);
            showToast("Job Updated Successfully!");
        } else {
            data.createdAt = serverTimestamp();

            // Status Logic for New Jobs
            if (data.status !== 'Draft') {
                if (data.status === 'Closed') {
                    // explicit
                } else if (data.status === 'Open' && data.closingDate) {
                    const closeDate = new Date(data.closingDate);
                    closeDate.setHours(23, 59, 59, 999);
                    data.status = new Date() > closeDate ? 'Closed' : 'Open';
                } else {
                    data.status = 'Open';
                }
            }
            await addDoc(collection(db, "jobs"), data);
            showToast("Job Created Successfully!");
        }

        document.getElementById('modal-job').classList.add('hidden');

        e.target.reset();
        document.getElementById('form-job-id').value = '';
    } catch (e) { alert("Error: " + e.message); }
    finally { btn.innerText = orig; btn.disabled = false; }
};


window.viewJobPipeline = (btn) => {
    const jobTitle = btn ? btn.getAttribute('data-jobtitle') : '';
    showSection('candidates');
    const searchEl = document.getElementById('global-search');
    const clearBtn = document.getElementById('clear-search');
    if (searchEl) {
        searchEl.value = jobTitle || '';
        globalSearchQuery = (jobTitle || '').toLowerCase();
        if (clearBtn) clearBtn.classList.toggle('hidden', !globalSearchQuery);
        updateSearchCount();
    }
    renderCandidates();
    renderWaCandidatesChecklist();
};

window.addCandidateForJob = (jobId, department) => {
    window.openCandidateModal();

    const form = document.getElementById('form-candidate');
    if (form) {
        form.reset();
        document.getElementById('form-candidate-id').value = '';
        document.getElementById('resume-upload-status').innerHTML = '';
    }

    const deptSelect = document.getElementById('candidate-job-dept-select');
    const jobSelect = document.getElementById('candidate-job-select');

    if (deptSelect) {
        deptSelect.value = department || '';
        // Ensure the jobs dropdown is updated for this department
        if (window.populateCandidateJobs) {
            window.populateCandidateJobs(department);
        }
    }

    if (jobSelect) {
        jobSelect.value = jobId || '';
    }

    // default contact flag is false for new candidates
    const contactCheckbox = document.getElementById('candidate-is-contact');
    if (contactCheckbox) {
        contactCheckbox.checked = false;
    }

    // Sync with custom UI
    try { initCustomSelects(); } catch (e) { console.warn('Sync failed in addCandidateForJob', e); }
};

window.toggleJobStatus = async (id, currentStatus) => {
    try {
        const newStatus = currentStatus === 'Open' ? 'Closed' : 'Open';
        const confirmMsg = newStatus === 'Closed'
            ? "Are you sure you want to close this job?"
            : "Are you sure you want to re-open this job?";

        if (!confirm(confirmMsg)) return;

        const updateData = { status: newStatus };
        if (newStatus === 'Closed') {
            const today = new Date();
            updateData.closingDate = today.toISOString().split('T')[0];
        } else {
            updateData.closingDate = null;
        }

        await updateDoc(doc(db, "jobs", id), updateData);
        showToast(`Job successfully marked as ${newStatus} !`);
    } catch (e) {
        alert("Error toggling job status: " + e.message);
    }
};

window.editJob = (id) => {
    const job = cachedJobs.find(j => j.id === id);
    if (!job) return;
    const form = document.getElementById('form-job');
    form.reset();

    function populateElement(element, value) {
        if (!element) return;
        const tag = (element.tagName || '').toUpperCase();

        if (tag === 'SELECT') {
            const valStr = value == null ? '' : String(value);
            const opt = Array.from(element.options).find(o => o.value === valStr || o.text === valStr);
            if (opt) {
                opt.selected = true;
                element.value = opt.value;
                element.dispatchEvent(new Event('change', { bubbles: true }));
            } else {
                // If matching option not found, clear as per user's choice
                element.value = '';
                element.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return;
        }

        // For radio/checkbox groups (RadioNodeList) or collections
        if (element instanceof RadioNodeList || (element.length && !element.tagName)) {
            try {
                for (let i = 0; i < element.length; i++) {
                    const child = element[i];
                    if (child.type === 'radio') {
                        child.checked = String(child.value) === String(value);
                    } else if (child.type === 'checkbox') {
                        // if value is boolean or matches value string
                        child.checked = !!value && (String(child.value) === String(value) || value === true || value === 'true');
                    } else {
                        child.value = value;
                    }
                }
            } catch (e) {
                // fallback
                try { element.value = value; } catch (e) { /* ignore */ }
            }
            return;
        }

        // Default for input, textarea, etc.
        try {
            if (Array.isArray(value)) {
                element.value = value.join('\n');
            } else {
                element.value = value == null ? '' : value;
            }
        } catch (e) { /* ignore */ }
    }

    for (const key in job) {
        const el = form.elements[key];
        if (!el) continue;

        let val = job[key];
        // Convert Full INR budget back to LPA for the form
        if (key === 'budget' && val > 1000) {
            val = val / 100000;
        }

        // Handle collections (multiple elements with same name)
        if (el.length && !el.tagName) {
            for (let i = 0; i < el.length; i++) {
                populateElement(el[i], val);
            }
        } else {
            populateElement(el, val);
        }
    }

    // Update Workspace UI
    document.getElementById('job-title-display').innerText = job.title || 'New Opening';
    const statusDisplay = document.getElementById('job-status-display');
    if (statusDisplay) {
        statusDisplay.innerText = job.status === 'Open' ? 'Active Pipeline' : (job.status === 'Closed' ? 'Filled / Closed' : 'Drafting Pipeline');
    }
    const budgetMonthly = document.getElementById('job-budget-monthly-imm');
    if (budgetMonthly && job.budget) {
        budgetMonthly.innerText = '≈ ₹' + Math.round(job.budget / 12).toLocaleString() + '/mo';
    }

    // Refresh custom select UI to reflect populated values
    try { initCustomSelects(); } catch (e) { console.warn('initCustomSelects in editJob failed', e); }
    // Ensure location is set according to company after population (override intentionally)
    try { prefillJobLocationFromCompany(); } catch (e) { /* ignore */ }
    document.getElementById('form-job-id').value = id;
    document.getElementById('modal-job-title').innerText = "Edit Job Configuration";
    openModal('modal-job');
};

// Cloudinary Config (Default fallback, dynamic values picked from portalSettings when available)
const CLOUDINARY_URL = 'https://api.cloudinary.com/v1_1/drz2jldgj/auto/upload';
const CLOUDINARY_PRESET = 'resume_uploads'; // <--- IMPORTANT: User must create this unsigned preset
let pendingResumeFile = null;

window.handleResumeSelection = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    pendingResumeFile = file;
    document.getElementById('resumeFileLabel').innerText = file.name.length > 20 ? file.name.substring(0, 20) + '...' : file.name;
    document.getElementById('resume-upload-status').innerHTML = `<span class="text-amber-500"><i class="fas fa-circle-notch fa-spin"></i> Ready to upload</span>`;
    document.getElementById('existing-resume-actions').classList.add('hidden'); // Hide existing actions if new file selected
};

window.clearResumeSelection = () => {
    pendingResumeFile = null;
    document.getElementById('resumeFileInput').value = '';
    document.getElementById('resumeFileLabel').innerText = 'Select File...';
    document.getElementById('resumeUrlHidden').value = '';
    document.getElementById('resume-upload-status').innerHTML = '';
    document.getElementById('existing-resume-actions').classList.add('hidden');
};

async function uploadResumeToCloudinary(file, publicId) {
    const formData = new FormData();
    formData.append('file', file);

    // Attempt to load dynamic portal settings if available
    let dynamicUrl = CLOUDINARY_URL;
    let dynamicPreset = CLOUDINARY_PRESET;
    try {
        const portalDoc = await window.getDoc(window.doc(window.db, "settings", "publicPortal"));
        if (portalDoc.exists()) {
            const pData = portalDoc.data();
            if (pData.cloudinaryUrl) dynamicUrl = pData.cloudinaryUrl;
            if (pData.cloudinaryPreset) dynamicPreset = pData.cloudinaryPreset;
        }
    } catch (e) {
        console.warn("Could not load dynamic Cloudinary settings, falling back to defaults.", e);
    }

    formData.append('upload_preset', dynamicPreset);
    formData.append('resource_type', 'raw'); // Better for Docs/PDFs
    formData.append('folder', 'resume_uploads');
    if (publicId) formData.append('public_id', publicId);

    console.log('Uploading to Cloudinary...', { url: dynamicUrl, preset: dynamicPreset });

    try {
        const res = await fetch(dynamicUrl.replace('/auto/', '/raw/'), {
            method: 'POST',
            body: formData,
            mode: 'cors'
        });

        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            console.error('Cloudinary API Error:', errData);
            throw new Error(errData.error?.message || `HTTP ${res.status} `);
        }

        const data = await res.json();
        if (data.error) throw new Error(data.error.message);

        // Clean the URL by removing the version (v1234567...) to make it look like the requested format
        // Cloudinary allows viewing without the version number if the public ID is unique.
        let cleanUrl = data.secure_url;
        if (cleanUrl.includes('/v')) {
            cleanUrl = cleanUrl.replace(/\/v\d+\//, '/');
        }
        return cleanUrl;
    } catch (err) {
        console.error('Cloudinary Internal Error:', err);
        throw err;
    }
}

document.getElementById('form-candidate').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const orig = btn.innerText; btn.innerText = "Processing..."; btn.disabled = true;
    try {
        const formData = new FormData(e.target);
        const data = Object.fromEntries(formData.entries());

        // Upload resume if a new file was selected
        if (pendingResumeFile) {
            btn.innerText = "Uploading Resume...";
            document.getElementById('resume-upload-status').innerHTML = `<span class="text-blue-500"><i class="fas fa-spinner fa-spin"></i> Uploading...</span>`;

            // Generate Custom Filename: Name + Dept + Date
            const cleanName = (data.name || 'Candidate').trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
            const cleanDept = (data.jobDepartment || 'Gen').trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
            const now = new Date();
            const dateStr = `${now.getFullYear()}_${String(now.getMonth() + 1).padStart(2, '0')
                }_${String(now.getDate()).padStart(2, '0')}`;
            const customPublicId = `${cleanName}_${cleanDept}_${dateStr}`;

            const resumeUrl = await uploadResumeToCloudinary(pendingResumeFile, customPublicId);
            data.resumeUrl = resumeUrl;
            document.getElementById('resume-upload-status').innerHTML = `<span class="text-green-500"><i class="fas fa-check-circle"></i> Uploaded!</span>`;
            pendingResumeFile = null; // Clear pending
        }

        // Numbers formatting
        data.expectedCTC = Number(data.expectedCTC);
        data.noticePeriod = Number(data.noticePeriod);
        data.experience = Number(data.experience);
        data.currentCTC = Number(data.currentCTC);
        if (data.offeredCTC) data.offeredCTC = Number(data.offeredCTC);

        // Contact flag for Contact Strategy
        data.isContact = (data.isContact === 'true' || data.isContact === true) ? true : false;

        // New Rating fields
        if (data.technicalRating) data.technicalRating = Number(data.technicalRating);
        if (data.communicationRating) data.communicationRating = Number(data.communicationRating);

        // Resolve Other Qualification
        if (data.qualification === 'Other' && data.qualificationOther) {
            data.qualification = data.qualificationOther;
        }

        // Compose Address for backwards-compatibility 
        data.address = [data.addressStreet, data.addressCity, data.addressState, data.addressPincode]
            .filter(Boolean).join(', ');

        const editId = data.id;
        delete data.id;

        if (editId) {
            await updateDoc(doc(db, "candidates", editId), data);
            showToast("Candidate Updated!");
        } else {
            data.createdAt = serverTimestamp();
            data.stage = 'Applied';
            data.inTalentPool = true;
            data.isNew = true;
            await addDoc(collection(db, "candidates"), data);
            showToast("Candidate Added!");
        }

        document.getElementById('modal-candidate').classList.add('hidden');

        e.target.reset();
        document.getElementById('form-candidate-id').value = '';
        document.getElementById('resume-upload-status').innerHTML = ''; // Reset status
        pendingResumeFile = null;
    } catch (e) {
        console.error("Form Submission Error:", e);
        alert("Error: " + e.message);
    }
    finally { btn.innerText = orig; btn.disabled = false; }
};

// --- HR Modal: Other Qualification Toggle ---
(function () {
    const qualSel = document.querySelector('#form-candidate select[name="qualification"]');
    const wrap = document.getElementById('hr-other-qual-wrap');
    const input = document.getElementById('hr-other-qual-input');
    if (!qualSel || !wrap || !input) return;
    qualSel.addEventListener('change', () => {
        const isOther = qualSel.value === 'Other';
        wrap.classList.toggle('hidden', !isOther);
        if (!isOther) input.value = '';
    });
    // Also expose a helper to set state when editCandidate runs
    window._hrSyncQualOther = (qualValue, qualOtherValue) => {
        const isOther = qualValue === 'Other';
        wrap.classList.toggle('hidden', !isOther);
        if (isOther) input.value = qualOtherValue || '';
    };
})();

// --- HR Modal: Pincode Auto-fill ---
(function () {
    const pincodeInput = document.getElementById('hr-address-pincode');
    const cityInput = document.getElementById('hr-address-city');
    const stateSelect = document.getElementById('hr-address-state');
    if (!pincodeInput || !cityInput || !stateSelect) return;

    function setStateOption(stateName) {
        const opts = Array.from(stateSelect.options);
        const match = opts.find(o => o.text.toLowerCase() === stateName.toLowerCase());
        if (match) stateSelect.value = match.value || match.text;
    }
    window._hrSetStateOption = setStateOption;

    let _t;
    pincodeInput.addEventListener('input', () => {
        const pin = pincodeInput.value.replace(/\D/g, '');
        clearTimeout(_t);
        pincodeInput.classList.remove('border-green-400', 'border-red-400');
        if (pin.length < 6) return;
        _t = setTimeout(async () => {
            try {
                const res = await fetch(`https://api.postalpincode.in/pincode/${pin}`);
                const json = await res.json();
                const po = json?.[0]?.PostOffice?.[0];
                if (po) {
                    if (!cityInput.value) cityInput.value = po.District || po.Name || '';
                    setStateOption(po.State || '');
                    pincodeInput.classList.add('border-green-400');
                } else {
                    pincodeInput.classList.add('border-red-400');
                }
            } catch { /* network fail – silent */ }
        }, 400);
    });
})();

window.editCandidate = (id) => {
    const cand = cachedCandidates.find(c => c.id === id);
    if (!cand) return;
    const form = document.getElementById('form-candidate');
    if (!form) return;

    form.reset();

    for (const key in cand) {
        if (form.elements[key]) {
            form.elements[key].value = cand[key] || '';
        }
    }

    // Update Initials & Profile UI
    const nameDisplay = document.getElementById('cand-name-display');
    if (nameDisplay) nameDisplay.innerText = cand.name || 'New Candidate';
    const statusDisplay = document.getElementById('cand-status-display');
    if (statusDisplay) statusDisplay.innerText = cand.stage || 'Applied';
    if (window.updateInitialsDisplay) window.updateInitialsDisplay(cand.name);

    // Set Ratings UI
    if (window.setRating) {
        window.setRating('technical', cand.technicalRating || 0);
        window.setRating('communication', cand.communicationRating || 0);
    }

    // Extended Fields Support
    const fAltPhone = form.elements['altPhone'];
    const fLinkedin = form.elements['linkedin'];
    const fScreener = form.elements['screenerNotes'];
    if (fAltPhone) fAltPhone.value = cand.altPhone || '';
    if (fLinkedin) fLinkedin.value = cand.linkedin || '';
    if (fScreener) fScreener.value = cand.screenerNotes || '';

    // Populate structured address fields (split from composite or individual)
    const hrCity = form.elements['addressCity'];
    const hrState = form.elements['addressState'];
    const hrPincode = form.elements['addressPincode'];
    const hrStreet = form.elements['addressStreet'];
    if (hrCity) hrCity.value = cand.addressCity || '';
    if (hrPincode) hrPincode.value = cand.addressPincode || '';
    if (hrStreet) hrStreet.value = cand.addressStreet || '';
    if (hrState && cand.addressState) {
        const opts = Array.from(hrState.options);
        const match = opts.find(o => o.text.toLowerCase() === (cand.addressState || '').toLowerCase());
        if (match) hrState.value = match.value || match.text;
    }

    // Handle Other Qualification
    if (window._hrSyncQualOther) {
        window._hrSyncQualOther(cand.qualification, cand.qualificationOther);
    }

    pendingResumeFile = null;
    const resumeInput = document.getElementById('resumeFileInput');
    if (resumeInput) resumeInput.value = '';
    const resumeLabel = document.getElementById('resumeFileLabel');
    if (resumeLabel) resumeLabel.innerText = 'Select File...';
    const resumeStatus = document.getElementById('resume-upload-status');
    if (resumeStatus) resumeStatus.innerHTML = '';
    const existingActions = document.getElementById('existing-resume-actions');
    const resumeUrlHidden = document.getElementById('resumeUrlHidden');

    if (cand.resumeUrl) {
        if (existingActions) existingActions.classList.remove('hidden');
        if (resumeUrlHidden) resumeUrlHidden.value = cand.resumeUrl;
    } else {
        if (existingActions) existingActions.classList.add('hidden');
        if (resumeUrlHidden) resumeUrlHidden.value = '';
    }

    // Ensure job select shows the candidate's applied job and update custom select UI
    try {
        const jobEl = form.elements['jobId'] || document.getElementById('candidate-job-select');
        const deptEl = form.elements['jobDepartment'] || document.getElementById('candidate-job-dept-select');
        // If candidate has jobId, find the job and set department first then job
        if (cand.jobId) {
            const job = cachedJobs.find(j => j.id === cand.jobId);
            if (deptEl && job) {
                deptEl.value = job.department || '';
            }
            // repopulate the job select according to dept before setting value (include current jobId)
            try { updateDropdowns(cand.jobId); } catch (e) { /* ignore */ }
            if (jobEl) {
                jobEl.value = cand.jobId || '';
                jobEl.dispatchEvent(new Event('change', { bubbles: true }));
            }
        } else {
            if (jobEl) {
                jobEl.value = '';
                jobEl.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }
    } catch (e) { console.warn('Could not set candidate job select', e); }

    try { initCustomSelects(); } catch (e) { console.warn('initCustomSelects in editCandidate failed', e); }
    document.getElementById('form-candidate-id').value = id;
    document.getElementById('modal-candidate-title').innerText = "Edit Candidate Profile";
    openModal('modal-candidate');
};

document.getElementById('form-interview').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const orig = btn.innerText; btn.innerText = "Saving..."; btn.disabled = true;
    try {
        const formData = new FormData(e.target);
        const data = Object.fromEntries(formData.entries());

        const candidateId = data.candidateId || document.getElementById('interview-candidate-id-hidden').value;
        const cand = cachedCandidates.find(c => c.id === candidateId);
        const currentStage = cand ? cand.stage || "Applied" : "Applied";

        const editId = data.id;
        delete data.id;

        if (editId) {
            await updateDoc(doc(db, "interviews", editId), data);
            showToast("Interview Updated!");
        } else {
            // Save the stage before this interview was scheduled
            data.previousStage = currentStage;
            await addDoc(collection(db, "interviews"), data);
            showToast("Interview Scheduled!");
        }

        // SYNC: Update candidate stage in database using centralized logic
        if (candidateId && data.status) {
            let newStage = currentStage;

            // Map interview status to candidate stage
            if (data.status === "Selected") newStage = "Selected";
            else if (data.status === "Rejected") newStage = "Rejected";
            else if (data.status === "Backed Out") newStage = "Backed Out";
            else if (data.status === "Not Interested") newStage = "Not Interested";
            else if (data.status === "Scheduled" || data.status === "Interviewed" || data.status === "On Hold") newStage = "Interview";

            // Use the centralized update function to trigger side effects (Offers, Job Closing, etc.)
            if (newStage !== currentStage) {
                await updateCandidateStage(candidateId, newStage);
            }
        }

        document.getElementById('modal-interview').classList.add('hidden');
        e.target.reset();
        document.getElementById('form-interview-id').value = '';
        document.getElementById('interview-candidate-search').value = '';
        document.getElementById('interview-candidate-id-hidden').value = '';
    } catch (e) { alert("Error: " + e.message); }
    finally { btn.innerText = orig; btn.disabled = false; }
};

window.handleInterviewCandidateSearch = (val) => {
    const list = document.getElementById('candidate-search-list');
    if (!list) return;

    const query = (val || '').toLowerCase();
    const rejectedStages = ['REJECTED', 'Rejected', 'Backed Out', 'Not Interested'];

    const matches = cachedCandidates.filter(c => {
        if (rejectedStages.includes(c.stage)) return false;
        if (!query) return true;
        return (c.name || '').toLowerCase().includes(query) ||
            (c.phone && c.phone.includes(query)) ||
            (c.email && c.email.toLowerCase().includes(query));
    }).slice(0, 20);

    list.innerHTML = matches.map(c =>
        `<option value="${c.name} | ${c.phone || ''} | ${c.email || ''}" data-id="${c.id}">`
    ).join('');
};

window.syncInterviewCandidateId = (val) => {
    const list = document.getElementById('candidate-search-list');
    if (!list) return;

    let option = Array.from(list.options).find(opt => opt.value === val);
    if (!option) {
        // fallback: match by name prefix if the user typed the displaytext
        option = Array.from(list.options).find(opt => (opt.value || '').toLowerCase().startsWith((val || '').toLowerCase()));
    }

    if (option) {
        const candId = option.getAttribute('data-id');
        const hiddenInput = document.getElementById('interview-candidate-id-hidden');
        if (hiddenInput) hiddenInput.value = candId || '';

        // Update Workspace Preview
        const cand = cachedCandidates.find(c => c.id === candId);
        if (cand) {
            const nameDisplay = document.getElementById('interview-cand-name-display');
            const initials = document.getElementById('interview-cand-initials');
            if (nameDisplay) nameDisplay.innerText = cand.name;
            if (initials) initials.innerText = cand.name.charAt(0).toUpperCase();
        }
    } else {
        const hiddenInput = document.getElementById('interview-candidate-id-hidden');
        if (hiddenInput) hiddenInput.value = '';
    }
};

window.editInterview = (id) => {
    const current = cachedInterviews.find(i => i.id === id);
    if (!current) return;
    const form = document.getElementById('form-interview');
    form.reset();
    for (const key in current) {
        if (form.elements[key]) form.elements[key].value = current[key];
    }

    // Populate searchable candidate input
    const cand = cachedCandidates.find(c => c.id === current.candidateId);
    if (cand) {
        document.getElementById('interview-candidate-search').value = `${cand.name} | ${cand.phone || ''} | ${cand.email}`;
        document.getElementById('interview-candidate-id-hidden').value = cand.id;

        // Update Workspace UI
        document.getElementById('interview-cand-name-display').innerText = cand.name;
        document.getElementById('interview-cand-initials').innerHTML = cand.name.charAt(0).toUpperCase();
    }

    document.getElementById('interview-round-display').innerText = current.round || 'Technical Round';

    document.getElementById('form-interview-id').value = id;
    document.getElementById('modal-interview-title').innerText = "Manage Interview & Feedback";
    openModal('modal-interview');
};

window.sendInterviewWhatsApp = (id) => {
    const i = cachedInterviews.find(i => i.id === id);
    if (!i || !i.candidateId) return;
    const cand = cachedCandidates.find(c => c.id === i.candidateId);
    if (!cand || !cand.phone) { alert("Candidate is missing a phone number."); return; }

    const templateId = document.getElementById(`template-select-${id}`)?.value;
    let message = "";

    if (templateId) {
        const template = cachedWaTemplates.find(t => t.id === templateId);
        message = formatWaMessage(template.content, cand, i);
    } else {
        const job = cachedJobs.find(j => j.id === cand.jobId);
        const date = new Date(i.dateTime).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
        message = `Hi ${cand.name}, this is a reminder regarding your interview for the ${job ? job.title : 'position'}.Scheduled on: ${date}.Mode: ${i.mode}. Please be prepared.Reply for any queries.`;
    }

    const cleanPhone = cand.phone.replace(/[^0-9+]/g, '');
    const url = new URL('https://api.whatsapp.com/send');
    url.searchParams.set('phone', cleanPhone);
    url.searchParams.set('text', message);
    window.open(url.toString(), '_blank');
};

window.sendInterviewEmail = (id) => {
    const i = cachedInterviews.find(i => i.id === id);
    if (!i || !i.candidateId) return;
    const cand = cachedCandidates.find(c => c.id === i.candidateId);
    if (!cand || !cand.email) { alert("Candidate is missing an email address."); return; }

    const templateId = document.getElementById(`template-select-${id}`)?.value;
    let body = "";
    let subject = "Interview Reminder";

    if (templateId) {
        const template = cachedWaTemplates.find(t => t.id === templateId);
        body = formatWaMessage(template.content, cand, i);
        const job = cachedJobs.find(j => j.id === cand.jobId);
        const company = job ? cachedCompanies.find(c => c.id === job.companyId) : null;
        const companyName = company ? company.name : (job ? (job.company || 'Recruitment Team') : 'Recruitment Team');
        subject = `Interview Reminder: ${job ? job.title : 'Position'} at ${companyName}`;
    } else {
        const job = cachedJobs.find(j => j.id === cand.jobId);
        const company = job ? cachedCompanies.find(c => c.id === job.companyId) : null;
        const companyName = company ? company.name : (job ? (job.company || 'Recruitment Team') : 'Recruitment Team');
        const date = new Date(i.dateTime).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
        subject = `Interview Reminder: ${job ? job.title : 'Position'} at ${companyName}`;
        body = `Hi ${cand.name}, \n\nThis is a reminder regarding your interview for the ${job ? job.title : 'position'}.\n\nScheduled on: ${date} \nMode: ${i.mode} \n\nPlease let us know if you have any questions.\n\nBest regards, \n${companyName}`;
    }

    const url = `mailto:${cand.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.open(url, '_blank');
};

document.getElementById('form-wa-template').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const orig = btn.innerText; btn.innerText = "Saving..."; btn.disabled = true;
    try {
        const formData = new FormData(e.target);
        const data = Object.fromEntries(formData.entries());

        const editId = data.id;
        delete data.id;

        if (editId) {
            await updateDoc(doc(db, "whatsappTemplates", editId), data);
            showToast("Template Updated!");
        } else {
            data.createdAt = serverTimestamp();
            await addDoc(collection(db, "whatsappTemplates"), data);
            showToast("Template Saved!");
        }

        document.getElementById('modal-wa-template').classList.add('hidden');
        e.target.reset();
        document.getElementById('form-wa-template-id').value = '';

        if (document.getElementById('wa-live-preview')) document.getElementById('wa-live-preview').innerHTML = `<div class="wa-message-bubble">Your message preview will appear here...</div>`;
        if (document.getElementById('wa-modal-preview')) document.getElementById('wa-modal-preview').innerHTML = `<div class="wa-message-bubble">Your message preview will appear here...</div>`;
    } catch (e) { alert("Error: " + e.message); }
    finally { btn.innerText = orig; btn.disabled = false; }
};

window.editWaTemplate = (id) => {
    const template = cachedWaTemplates.find(t => t.id === id);
    if (!template) return;
    const form = document.getElementById('form-wa-template');
    form.reset();
    for (const key in template) {
        if (form.elements[key]) form.elements[key].value = template[key];
    }
    document.getElementById('form-wa-template-id').value = id;
    document.getElementById('modal-wa-template-title').innerText = "Edit Messaging Template";
    openModal('modal-wa-template');
};

window.updateCandidateStage = async (id, stage) => {
    try {
        const poolStages = ['REJECTED', 'Rejected', 'Backed Out', 'Not Interested', 'Applied'];
        const updateData = {
            stage,
            inTalentPool: poolStages.includes(stage),
            isNew: false,
            updatedAt: serverTimestamp()
        };

        if (stage === 'Hired') {
            updateData.hiredAt = serverTimestamp();
        }

        if (stage === 'Selected') {
            const cand = cachedCandidates.find(c => c.id === id);
            const job = cand ? cachedJobs.find(j => j.id === cand.jobId) : null;

            // Check if offer already exists to avoid duplicates
            const existingOffer = cachedOffers.find(o => o.candidateId === id);

            if (!existingOffer) {
                await addDoc(collection(db, "offers"), {
                    candidateId: id,
                    candidateName: cand ? cand.name : 'Unknown',
                    jobId: cand ? cand.jobId : null,
                    jobTitle: job ? job.title : 'Position Unknown',
                    offeredCTC: cand ? (cand.offeredCTC || cand.expectedCTC || 0) : 0,
                    status: 'Pending',
                    createdAt: serverTimestamp(),
                    updatedAt: serverTimestamp()
                });
            }
        }
        await updateDoc(doc(db, "candidates", id), updateData);

        const cand = cachedCandidates.find(c => c.id === id);
        if (cand && cand.jobId) {
            if (stage === 'Selected' || stage === 'Hired') {
                const yesterday = new Date();
                yesterday.setDate(yesterday.getDate() - 1);
                const closingDateStr = yesterday.toISOString().split('T')[0];

                await updateDoc(doc(db, "jobs", cand.jobId), {
                    closingDate: closingDateStr,
                    status: 'Closed'
                });
                showToast("Stage Updated & Job Closed!");
            } else {
                // Read the job doc directly from Firestore instead of relying
                // on the local cache, which may not have been updated yet.
                const jobRef = doc(db, "jobs", cand.jobId);
                const jobSnap = await getDoc(jobRef);
                if (jobSnap.exists()) {
                    const jobData = jobSnap.data();

                    // ONLY re-open if the candidate was PREVIOUSLY Hired or Selected
                    // and is now moving to a different stage.
                    const wasHired = cand.stage === 'Selected' || cand.stage === 'Hired';

                    if (wasHired && (jobData.status === 'Closed' || jobData.closingDate)) {
                        // Before re-opening, check if any other candidates
                        // are still Hired/Selected for this same job.
                        const otherHired = cachedCandidates.some(c =>
                            c.id !== id &&
                            c.jobId === cand.jobId &&
                            (c.stage === 'Selected' || c.stage === 'Hired')
                        );
                        if (!otherHired) {
                            await updateDoc(jobRef, {
                                closingDate: null,
                                status: 'Open'
                            });
                            showToast("Stage Updated & Job Re-opened!");
                        } else {
                            showToast("Stage Updated (Job remains closed — other candidates are still Hired/Selected)");
                        }
                    } else {
                        showToast("Stage Updated");
                    }
                } else {
                    showToast("Stage Updated");
                }
            }
        } else {
            showToast("Stage Updated");
        }
    } catch (e) { alert("Error updating stage: " + e.message); }
};

// ===================== EXCEL REPORTING LOGIC =====================
window.exportToExcel = (data, filename, sheetName = "Sheet1") => {
    try {
        const worksheet = XLSX.utils.json_to_sheet(data);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
        XLSX.writeFile(workbook, `${filename}_${new Date().toISOString().split('T')[0]}.xlsx`);
        showToast("Report Generated!");
    } catch (e) {
        console.error("Export Error:", e);
        alert("Error generating Excel report: " + e.message);
    }
};

window.fetchCandidatesReport = () => {
    const data = cachedCandidates.map(c => {
        const job = cachedJobs.find(j => j.id === c.jobId);
        const company = job ? cachedCompanies.find(co => co.id === job.companyId) : null;
        return {
            // ── Personal Details ──
            "Candidate Name": c.name || "N/A",
            "Email": c.email || "N/A",
            "Phone": c.phone || "N/A",
            "Qualification": c.qualification || "N/A",
            "Address": c.address || "N/A",
            // ── Professional Details ──
            "Current Company": c.currentCompany || "N/A",
            "Designation": c.designation || "N/A",
            "Experience (Years)": c.experience || 0,
            "Source": c.source || "N/A",
            // ── Applied Position ──
            "Applied For (Job)": job ? job.title : "N/A",
            "Department": job ? (job.department || "N/A") : "N/A",
            "Company": company ? company.name : "N/A",
            // ── CTC & Financials (Monthly) ──
            "Current CTC (Monthly ₹)": c.currentCTC || 0,
            "Current CTC Annual (LPA)": c.currentCTC ? +((c.currentCTC * 12) / 100000).toFixed(2) : 0,
            "Expected CTC (Monthly ₹)": c.expectedCTC || 0,
            "Expected CTC Annual (LPA)": c.expectedCTC ? +((c.expectedCTC * 12) / 100000).toFixed(2) : 0,
            "Final / Offered CTC (Monthly ₹)": c.offeredCTC || "TBD",
            "Final CTC Annual (LPA)": c.offeredCTC ? +((Number(c.offeredCTC) * 12) / 100000).toFixed(2) : "TBD",
            "Notice Period (Days)": c.noticePeriod || 0,
            "Why Changing Job": c.whyChangeJob || "N/A",
            // ── Status ──
            "Pipeline Stage": c.stage || "Applied",
            "Offer Letter Sent": c.offerLetterSent || "No",
            "Added Date": c.createdAt ? new Date(c.createdAt.seconds * 1000).toLocaleDateString() : "N/A"
        };
    });
    exportToExcel(data, "Candidates_Report", "Candidates");
};

window.fetchJobsReport = () => {
    const data = cachedJobs.map(j => {
        const company = cachedCompanies.find(c => c.id === j.companyId);
        const jobCandidates = cachedCandidates.filter(c => c.jobId === j.id);
        const countByStage = (stage) => jobCandidates.filter(c => c.stage === stage).length;
        return {
            // ── Job Details ──
            "Job Title": j.title || "N/A",
            "Designation": j.designation || "N/A",
            "Company": company ? company.name : "N/A",
            "Department": j.department || "N/A",
            "Min. Qualification": j.qualification || "N/A",
            "Location": j.location || "N/A",
            "Budget (INR)": j.budget || 0,
            "Hiring Priority": j.priority || "Medium",
            "Status": j.status || "Open",
            "Closing Date": j.closingDate || "N/A",
            "MRF Received": j.mrfReceived || "No",
            "Required Skills": j.skills || "N/A",
            "Job Description": j.description || "N/A",
            // ── Pipeline Counts ──
            "Total Candidates": jobCandidates.length,
            "Applied": countByStage("Applied"),
            "Screening": countByStage("Screening"),
            "Interview": countByStage("Interview"),
            "Selected": countByStage("Selected"),
            "Hired": countByStage("Hired"),
            "Rejected": countByStage("Rejected"),
            // ── Timestamps ──
            "Posted Date": j.createdAt ? new Date(j.createdAt.seconds * 1000).toLocaleDateString() : "N/A"
        };
    });
    exportToExcel(data, "Jobs_Report", "Jobs");
};

window.fetchCompaniesReport = () => {
    const data = cachedCompanies.map(c => {
        const companyJobs = cachedJobs.filter(j => j.companyId === c.id);
        const openJobs = companyJobs.filter(j => j.status !== 'Closed').length;
        const closedJobs = companyJobs.filter(j => j.status === 'Closed').length;
        const totalCandidates = cachedCandidates.filter(cd => {
            const job = cachedJobs.find(j => j.id === cd.jobId);
            return job && job.companyId === c.id;
        }).length;
        return {
            // ── Company Details ──
            "Company Name": c.name || "N/A",
            "Industry": c.industry || "N/A",
            "Location / HQ": c.location || "N/A",
            "Full Address": c.address || "N/A",
            "Website": c.website || "N/A",
            "About": c.about || "N/A",
            // ── Recruitment Stats ──
            "Total Job Openings": companyJobs.length,
            "Open Positions": openJobs,
            "Closed Positions": closedJobs,
            "Total Candidates": totalCandidates,
            // ── Timestamps ──
            "Added Date": c.createdAt ? new Date(c.createdAt.seconds * 1000).toLocaleDateString() : "N/A"
        };
    });
    exportToExcel(data, "Companies_Report", "Companies");
};

window.fetchInterviewsReport = () => {
    const data = cachedInterviews.map(i => {
        const candidate = cachedCandidates.find(c => c.id === i.candidateId);
        const job = candidate ? cachedJobs.find(j => j.id === candidate.jobId) : null;
        const company = job ? cachedCompanies.find(co => co.id === job.companyId) : null;
        return {
            // ── Candidate Info ──
            "Candidate Name": candidate ? candidate.name : "N/A",
            "Candidate Phone": candidate ? (candidate.phone || "N/A") : "N/A",
            "Candidate Email": candidate ? (candidate.email || "N/A") : "N/A",
            "Current Company": candidate ? (candidate.currentCompany || "N/A") : "N/A",
            "Candidate Stage": candidate ? (candidate.stage || "N/A") : "N/A",
            // ── Interview Details ──
            "Interviewer": i.interviewer || "N/A",
            "Date & Time": i.dateTime ? i.dateTime.replace('T', ' ') : "N/A",
            "Mode": i.mode || "N/A",
            "Status": i.status || "Scheduled",
            "Meeting Link / Location": i.meetingLink || "N/A",
            "Feedback": i.feedback || "N/A",
            // ── Job & Company ──
            "Job Title": job ? (job.title || "N/A") : "N/A",
            "Department": job ? (job.department || "N/A") : "N/A",
            "Company": company ? company.name : "N/A"
        };
    });
    exportToExcel(data, "Interviews_Report", "Interviews");
};

window.fetchTemplatesReport = () => {
    const data = cachedWaTemplates.map(t => ({
        "Template Name": t.name || "N/A",
        "Category / Type": t.type || "N/A",
        "Content": t.content || "N/A",
        "Created Date": t.createdAt ? new Date(t.createdAt.seconds * 1000).toLocaleDateString() : "N/A",
        "Last Updated": t.updatedAt ? new Date(t.updatedAt.seconds * 1000).toLocaleDateString() : "N/A"
    }));
    exportToExcel(data, "Messaging_Templates_Report", "Templates");
};

// --- RESUME PREVIEWER LOGIC ---
window.previewResume = (url) => {
    if (!url) return;
    const modal = document.getElementById('modal-resume-preview');
    const iframe = document.getElementById('resume-preview-iframe');
    const loader = document.getElementById('resume-preview-loader');
    const downloadLink = document.getElementById('resume-download-link');

    if (!modal || !iframe) return;

    // Show loader, hide iframe initially
    if (loader) loader.classList.remove('hidden');
    iframe.style.opacity = '0';

    iframe.src = url;
    if (downloadLink) downloadLink.href = url;

    iframe.onload = () => {
        if (loader) loader.classList.add('hidden');
        iframe.style.opacity = '1';
        iframe.style.transition = 'opacity 0.3s ease';
    };

    openModal('modal-resume-preview');
};

window.downloadResumeCurrent = async () => {
    const iframe = document.getElementById('resume-preview-iframe');
    const url = iframe ? iframe.src : null;
    if (!url || url === 'about:blank') return;

    const btn = document.getElementById('resume-download-btn-forced');
    const orig = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Downloading...';
    btn.disabled = true;

    try {
        const response = await fetch(url);
        const blob = await response.blob();
        const blobUrl = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = blobUrl;
        // Try to extract filename from URL or use a default
        const filename = url.split('/').pop().split('?')[0] || 'resume.pdf';
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(blobUrl);
        document.body.removeChild(a);
        showToast("Download Started!");
    } catch (e) {
        console.error("Download failed:", e);
        // Fallback to opening in new tab if blob fetch fails
        window.open(url, '_blank');

        btn.innerHTML = orig;
        btn.disabled = false;
    }
};

window.shareResumeCurrent = () => {
    const iframe = document.getElementById('resume-preview-iframe');
    const url = iframe ? iframe.src : null;
    if (!url || url === 'about:blank') return;

    if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(() => {
            showToast("Link copied to clipboard!");
        }).catch(err => {
            console.error('Link copy failed:', err);
        });
    } else {
        // Fallback for older browsers
        const textArea = document.createElement("textarea");
        textArea.value = url;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        showToast("Link copied!");
    }
};

// ===================== ADVANCED REPORT BUILDER =====================
let advReportType = 'candidates';
let advReportItems = [];
let advReportSelectedIds = new Set();
let advReportFilters = {};

window.openAdvancedReport = (type) => {
    advReportType = type;
    advReportSelectedIds.clear();
    advReportFilters = {};
    const searchEl = document.getElementById('advanced-report-search');
    if (searchEl) searchEl.value = '';

    const selectAllEl = document.getElementById('advanced-report-select-all');
    if (selectAllEl) selectAllEl.checked = false;

    document.getElementById('advanced-report-title').innerText = type === 'candidates' ? 'Advanced Candidates Report' : 'Advanced Jobs Report';

    renderAdvancedReportFilters();
    applyAdvancedFilters(); // This will eventually call renderAdvancedReportItems

    openModal('modal-advanced-report');
};

const renderAdvancedReportFilters = () => {
    const container = document.getElementById('advanced-report-filters-container');
    let html = '';

    if (advReportType === 'candidates') {
        // Get unique lists for candidates
        const depts = [...new Set(cachedJobs.map(j => j.department).filter(Boolean))];
        const stages = [...new Set(cachedCandidates.map(c => c.stage).filter(Boolean))];
        const sources = [...new Set(cachedCandidates.map(c => c.source).filter(Boolean))];

        html += createFilterDropdown('Job Department', 'dept', depts);
        html += createFilterDropdown('Current Stage', 'stage', stages);
        html += createFilterDropdown('Source', 'source', sources);

        // Set Bottom Options
        document.getElementById('advanced-report-options-container').innerHTML = `
                    <label for="adv-opt-ctc" class="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 font-medium whitespace-nowrap">
                        <input type="checkbox" id="adv-opt-ctc" checked class="rounded text-blue-600 focus:ring-blue-500 w-4 h-4 bg-white border-gray-300 border"> Include Financials (CTC)
                    </label>
                    <label for="adv-opt-contact" class="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 font-medium whitespace-nowrap">
                        <input type="checkbox" id="adv-opt-contact" checked class="rounded text-blue-600 focus:ring-blue-500 w-4 h-4 bg-white border-gray-300 border"> Include Contact Info
                    </label>
                `;
    } else if (advReportType === 'jobs') {
        const depts = [...new Set(cachedJobs.map(j => j.department).filter(Boolean))];
        const statuses = ['Open', 'Closed'];

        html += createFilterDropdown('Department', 'dept', depts);
        html += createFilterDropdown('Status', 'status', statuses);

        document.getElementById('advanced-report-options-container').innerHTML = `
                    <label for="adv-opt-budget" class="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 font-medium whitespace-nowrap">
                        <input type="checkbox" id="adv-opt-budget" checked class="rounded text-blue-600 focus:ring-blue-500 w-4 h-4 bg-white border-gray-300 border"> Include Budget Exp.
                    </label>
                `;
    }

    container.innerHTML = html;
};

const createFilterDropdown = (label, key, options) => {
    let optsHtml = '<option value="">All</option>';
    options.sort().forEach(opt => {
        optsHtml += `<option value="${opt}">${opt}</option>`;
    });
    return `
                <div>
                    <label for="adv-filter-${key}" class="block text-xs font-bold text-slate-500 dark:text-slate-400 mb-2 uppercase tracking-wider">${label}</label>
                    <select id="adv-filter-${key}" onchange="applyAdvancedFilters()" class="w-full theme-input rounded-xl border border-slate-300 dark:border-slate-600 text-sm py-2 px-3 focus:ring-2 focus:ring-blue-500 transition-shadow bg-white dark:bg-slate-700">
                        ${optsHtml}
                    </select>
                </div>
            `;
};

window.clearAdvancedFilters = () => {
    const selects = document.querySelectorAll('#advanced-report-filters-container select');
    selects.forEach(s => s.value = '');
    const searchEl = document.getElementById('advanced-report-search');
    if (searchEl) searchEl.value = '';

    advReportSelectedIds.clear();
    const selectAllEl = document.getElementById('advanced-report-select-all');
    if (selectAllEl) selectAllEl.checked = false;

    applyAdvancedFilters(false);
};

window.applyAdvancedFilters = (autoSelect = true) => {
    const searchElement = document.getElementById('advanced-report-search');
    let search = '';
    if (searchElement) {
        search = searchElement.value.toLowerCase();
    }
    advReportFilters = {};

    if (advReportType === 'candidates') {
        const deptFilter = document.getElementById('adv-filter-dept')?.value;
        const stageFilter = document.getElementById('adv-filter-stage')?.value;
        const sourceFilter = document.getElementById('adv-filter-source')?.value;

        advReportItems = cachedCandidates.filter(c => {
            const job = cachedJobs.find(j => j.id === c.jobId);
            if (deptFilter && (!job || job.department !== deptFilter)) return false;
            if (stageFilter && c.stage !== stageFilter) return false;
            if (sourceFilter && c.source !== sourceFilter) return false;

            if (search) {
                const searchStr = `${c.name} ${c.email} ${job?.title} ${c.stage} ${c.source}`.toLowerCase();
                if (!searchStr.includes(search)) return false;
            }
            return true;
        });
    } else if (advReportType === 'jobs') {
        const deptFilter = document.getElementById('adv-filter-dept')?.value;
        const statusFilter = document.getElementById('adv-filter-status')?.value;

        advReportItems = cachedJobs.filter(j => {
            if (deptFilter && j.department !== deptFilter) return false;

            let computedStatus = j.status;
            if (!computedStatus) {
                const nowStr = new Date().toISOString().split('T')[0];
                computedStatus = (j.closingDate && j.closingDate <= nowStr) ? 'Closed' : 'Open';
            }

            if (statusFilter && computedStatus !== statusFilter) return false;

            if (search) {
                const searchStr = `${j.title} ${j.department} ${computedStatus}`.toLowerCase();
                if (!searchStr.includes(search)) return false;
            }
            return true;
        });
    }

    if (autoSelect) {
        // Sync selection: Add all filtered items to selection when applying filters
        advReportSelectedIds.clear(); // Clear existing selections first
        advReportItems.forEach(item => advReportSelectedIds.add(item.id)); // Select all filtered
    } else {
        // Remove ids that are no longer in the filtered list
        const currentItemIds = new Set(advReportItems.map(i => i.id));
        for (let id of advReportSelectedIds) {
            if (!currentItemIds.has(id)) advReportSelectedIds.delete(id);
        }
    }

    renderAdvancedReportItems();
};

window.renderAdvancedReportItems = () => {
    const container = document.getElementById('advanced-report-items-container');
    const header = document.getElementById('advanced-report-table-header');

    let html = '';

    if (advReportType === 'candidates') {
        header.innerHTML = `<div>Candidate Details</div><div>Applied Position</div>`;
        advReportItems.forEach(c => {
            const job = cachedJobs.find(j => j.id === c.jobId);
            const isSelected = advReportSelectedIds.has(c.id);
            html += `
                        <label class="flex items-center px-6 py-3 border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer transition-colors ${isSelected ? 'bg-blue-50 dark:bg-blue-900/20' : ''}">
                            <div class="w-12 flex justify-center">
                                <input type="checkbox" onchange="toggleReportItemSelection('${c.id}', this.checked)" ${isSelected ? 'checked' : ''} class="w-4 h-4 rounded text-blue-600 focus:ring-blue-500 bg-white border border-gray-300">
                            </div>
                            <div class="flex-1 grid grid-cols-2 gap-4">
                                <div>
                                    <div class="font-semibold text-slate-800 dark:text-slate-200 text-sm whitespace-nowrap overflow-hidden text-ellipsis">${c.name || 'N/A'}</div>
                                    <div class="text-xs text-slate-500 whitespace-nowrap overflow-hidden text-ellipsis">${c.email || 'N/A'} <span class="mx-1">•</span> <span class="font-medium text-blue-600">${c.stage || 'N/A'}</span></div>
                                </div>
                                <div>
                                    <div class="text-sm text-slate-700 dark:text-slate-300 whitespace-nowrap overflow-hidden text-ellipsis">${job ? job.title : 'N/A'}</div>
                                    <div class="text-xs text-slate-500 whitespace-nowrap overflow-hidden text-ellipsis">${job ? job.department : 'N/A'}</div>
                                </div>
                            </div>
                        </label>
                    `;
        });
    } else if (advReportType === 'jobs') {
        header.innerHTML = `<div>Job Details</div><div>Status / Candidates</div>`;
        advReportItems.forEach(j => {
            const isSelected = advReportSelectedIds.has(j.id);
            const candCount = cachedCandidates.filter(c => c.jobId === j.id).length;

            let computedStatus = j.status;
            if (!computedStatus) {
                const nowStr = new Date().toISOString().split('T')[0];
                computedStatus = (j.closingDate && j.closingDate <= nowStr) ? 'Closed' : 'Open';
            }

            html += `
                        <label class="flex items-center px-6 py-3 border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer transition-colors ${isSelected ? 'bg-blue-50 dark:bg-blue-900/20' : ''}">
                            <div class="w-12 flex justify-center">
                                <input type="checkbox" onchange="toggleReportItemSelection('${j.id}', this.checked)" ${isSelected ? 'checked' : ''} class="w-4 h-4 rounded text-blue-600 focus:ring-blue-500 bg-white border border-gray-300">
                            </div>
                            <div class="flex-1 grid grid-cols-2 gap-4">
                                <div>
                                    <div class="font-semibold text-slate-800 dark:text-slate-200 text-sm whitespace-nowrap overflow-hidden text-ellipsis">${j.title}</div>
                                    <div class="text-xs text-slate-500 whitespace-nowrap overflow-hidden text-ellipsis">${j.department || 'N/A'}</div>
                                </div>
                                <div>
                                    <div class="text-sm font-bold ${computedStatus === 'Open' ? 'text-green-600' : 'text-slate-500'}">${computedStatus}</div>
                                    <div class="text-xs text-slate-500">${candCount} Candidates Linked</div>
                                </div>
                            </div>
                        </label>
                    `;
        });
    }

    if (advReportItems.length === 0) {
        html = `<div class="p-12 text-center text-slate-500 dark:text-slate-400 italic flex flex-col items-center gap-3">
                    <i class="fas fa-search text-3xl opacity-30"></i>
                    <span>No items match your master filters.</span>
                </div>`;
    }

    container.innerHTML = html;

    document.getElementById('advanced-report-total-count').innerText = `Total Rows: ${advReportItems.length}`;
    document.getElementById('advanced-report-selected-count').innerText = `Rows Selected: ${advReportSelectedIds.size}`;

    const selectAllCheckbox = document.getElementById('advanced-report-select-all');
    if (selectAllCheckbox) {
        selectAllCheckbox.checked = advReportItems.length > 0 && advReportSelectedIds.size === advReportItems.length;
    }
};

window.toggleAllReportSelection = (checked) => {
    if (checked) {
        advReportItems.forEach(item => advReportSelectedIds.add(item.id));
    } else {
        advReportSelectedIds.clear();
    }
    renderAdvancedReportItems();
};

window.toggleReportItemSelection = (id, checked) => {
    if (checked) {
        advReportSelectedIds.add(id);
    } else {
        advReportSelectedIds.delete(id);
    }
    renderAdvancedReportItems();
};

window.exportCustomReport = () => {
    if (advReportSelectedIds.size === 0) {
        alert("Please select at least one row from the right panel to export.");
        return;
    }

    if (advReportType === 'candidates') {
        const includeCTC = document.getElementById('adv-opt-ctc')?.checked;
        const includeContact = document.getElementById('adv-opt-contact')?.checked;

        const selectedCandidates = cachedCandidates.filter(c => advReportSelectedIds.has(c.id));
        const data = selectedCandidates.map(c => {
            const job = cachedJobs.find(j => j.id === c.jobId);
            const company = job ? cachedCompanies.find(co => co.id === job.companyId) : null;

            let row = {
                "Candidate Name": c.name || "N/A",
                "Qualification": c.qualification || "N/A"
            };

            if (includeContact) {
                row["Email"] = c.email || "N/A";
                row["Phone"] = c.phone || "N/A";
                row["Gender"] = c.gender || "N/A";
                row["Address"] = c.address || "N/A";
            }

            row["Current Company"] = c.currentCompany || "N/A";
            row["Designation"] = c.designation || "N/A";
            row["Experience (Years)"] = c.experience || 0;
            row["Source"] = c.source || "N/A";
            row["Applied For (Job)"] = job ? job.title : "N/A";
            row["Department"] = job ? (job.department || "N/A") : "N/A";
            row["Company"] = company ? company.name : "N/A";

            if (includeCTC) {
                row["Budget CTC (Monthly ₹)"] = job ? +((job.budget) / 12).toFixed(2) : 0;
                row["Budget CTC Annual (LPA)"] = job ? +((job.budget) / 100000).toFixed(2) : 0;
                row["Current CTC (Monthly ₹)"] = c.currentCTC || 0;
                row["Current CTC Annual (LPA)"] = c.currentCTC ? +((c.currentCTC * 12) / 100000).toFixed(2) : 0;
                row["Expected CTC (Monthly ₹)"] = c.expectedCTC || 0;
                row["Expected CTC Annual (LPA)"] = c.expectedCTC ? +((c.expectedCTC * 12) / 100000).toFixed(2) : 0;
                row["Final / Offered CTC (Monthly ₹)"] = c.offeredCTC || "TBD";
                row["Final CTC Annual (LPA)"] = c.offeredCTC ? +((Number(c.offeredCTC) * 12) / 100000).toFixed(2) : "TBD";
                row["Difference (Monthly ₹)"] = (c.offeredCTC && job) ? +((Number(c.offeredCTC) - (job.budget / 12))).toFixed(2) : "TBD";
                row["Difference (Annual LPA)"] = (c.offeredCTC && job) ? +(((Number(c.offeredCTC) * 12) - job.budget) / 100000).toFixed(2) : "TBD";
            }

            row["Stage"] = c.stage || "N/A";
            row["Status"] = c.status || "N/A";
            row["Created Date"] = c.createdAt ? new Date(c.createdAt.seconds * 1000).toLocaleDateString() : "N/A";

            return row;
        });
        exportToExcel(data, "Custom_Candidates_Report");

    } else if (advReportType === 'jobs') {
        const includeBudget = document.getElementById('adv-opt-budget')?.checked;

        const selectedJobs = cachedJobs.filter(j => advReportSelectedIds.has(j.id));
        const data = selectedJobs.map(job => {
            const company = cachedCompanies.find(co => co.id === job.companyId);

            let computedStatus = job.status;
            if (!computedStatus) {
                const nowStr = new Date().toISOString().split('T')[0];
                computedStatus = (job.closingDate && job.closingDate <= nowStr) ? 'Closed' : 'Open';
            }

            let row = {
                "Job Title": job.title,
                "Department": job.department || "N/A",
                "Company": company ? company.name : "N/A",
                "Location": job.location || "N/A",
                "Job Type": job.type || "N/A",
                "Experience Needed": job.experience || "N/A",
                "Total Openings": job.openings || 1,
                "Hired Candidates": cachedCandidates.filter(c => c.jobId === job.id && (c.stage === 'Hired')).length,
                "Status": computedStatus
            };

            if (includeBudget) {
                row["Budget (Annual ₹)"] = job.budget || 0;
                row["Budget (Monthly ₹)"] = job.budget ? +(job.budget / 12).toFixed(2) : 0;
            }

            row["Created Date"] = job.createdAt ? new Date(job.createdAt.seconds * 1000).toLocaleDateString() : "N/A";
            row["Closing Date"] = job.closingDate || "N/A";

            return row;
        });
        exportToExcel(data, "Custom_Jobs_Report");
    }

    closeModal('modal-advanced-report');
};

window.fetchCandidatesReport = () => {
    const data = cachedCandidates.map(c => {
        const job = cachedJobs.find(j => j.id === c.jobId);
        const company = job ? cachedCompanies.find(co => co.id === job.companyId) : null;
        return {
            // ── Personal Details ──
            "Candidate Name": c.name || "N/A",
            "Email": c.email || "N/A",
            "Phone": c.phone || "N/A",
            "Gender": c.gender || "N/A",
            "Qualification": c.qualification || "N/A",
            "Address": c.address || "N/A",
            // ── Professional Details ──
            "Current Company": c.currentCompany || "N/A",
            "Designation": c.designation || "N/A",
            "Experience (Years)": c.experience || 0,
            "Source": c.source || "N/A",
            // ── Applied Position ──
            "Applied For (Job)": job ? job.title : "N/A",
            "Department": job ? (job.department || "N/A") : "N/A",
            "Company": company ? company.name : "N/A",
            // ── CTC & Financials (Monthly) ──
            "Budget CTC (Monthly ₹)": job ? +((job.budget) / 12).toFixed(2) : 0,
            "Budget CTC Annual (LPA)": job ? +((job.budget) / 100000).toFixed(2) : 0,
            "Current CTC (Monthly ₹)": c.currentCTC || 0,
            "Current CTC Annual (LPA)": c.currentCTC ? +((c.currentCTC * 12) / 100000).toFixed(2) : 0,
            "Expected CTC (Monthly ₹)": c.expectedCTC || 0,
            "Expected CTC Annual (LPA)": c.expectedCTC ? +((c.expectedCTC * 12) / 100000).toFixed(2) : 0,
            "Final / Offered CTC (Monthly ₹)": c.offeredCTC || "TBD",
            "Final CTC Annual (LPA)": c.offeredCTC ? +((Number(c.offeredCTC) * 12) / 100000).toFixed(2) : "TBD",
            "Difference (Monthly ₹)": (c.offeredCTC && job) ? +((Number(c.offeredCTC) - (job.budget / 12))).toFixed(2) : "TBD",
            "Difference (Annual LPA)": (c.offeredCTC && job) ? +(((Number(c.offeredCTC) * 12) - job.budget) / 100000).toFixed(2) : "TBD",
            "Notice Period (Days)": c.noticePeriod || 0,
            "Why Changing Job": c.whyChangeJob || "N/A",
            // ── Status ──
            "Pipeline Stage": c.stage || "Applied",
            "Offer Letter Sent": c.offerLetterSent || "No",
            "Added Date": c.createdAt ? new Date(c.createdAt.seconds * 1000).toLocaleDateString() : "N/A"
        };
    });
    exportToExcel(data, "Candidates_Report", "Candidates");
};

window.fetchJobsReport = () => {
    const data = cachedJobs.map(j => {
        const company = cachedCompanies.find(c => c.id === j.companyId);
        const jobCandidates = cachedCandidates.filter(c => c.jobId === j.id);
        const countByStage = (stage) => jobCandidates.filter(c => c.stage === stage).length;
        return {
            // ── Job Details ──
            "Job Title": j.title || "N/A",
            "Designation": j.designation || "N/A",
            "Company": company ? company.name : "N/A",
            "Department": j.department || "N/A",
            "Min. Qualification": j.qualification || "N/A",
            "Location": j.location || "N/A",
            "Budget (INR)": j.budget || 0,
            "Hiring Priority": j.priority || "Medium",
            "Status": j.status || "Open",
            "Closing Date": j.closingDate || "N/A",
            "MRF Received": j.mrfReceived || "No",

            "Job Description": j.description || "N/A",
            // ── Pipeline Counts ──
            "Total Candidates": jobCandidates.length,
            "Applied": countByStage("Applied"),
            "Screening": countByStage("Screening"),
            "Interview": countByStage("Interview"),
            "Selected": countByStage("Selected"),
            "Hired": countByStage("Hired"),
            "Rejected": countByStage("Rejected"),
            "Backed Out": countByStage("Backed Out"),
            "Not Interested": countByStage("Not Interested"),
            // ── Timestamps ──
            "Posted Date": j.createdAt ? new Date(j.createdAt.seconds * 1000).toLocaleDateString() : "N/A"
        };
    });
    exportToExcel(data, "Jobs_Report", "Jobs");
};

window.fetchCompaniesReport = () => {
    const data = cachedCompanies.map(c => {
        const companyJobs = cachedJobs.filter(j => j.companyId === c.id);
        const openJobs = companyJobs.filter(j => j.status !== 'Closed').length;
        const closedJobs = companyJobs.filter(j => j.status === 'Closed').length;
        const totalCandidates = cachedCandidates.filter(cd => {
            const job = cachedJobs.find(j => j.id === cd.jobId);
            return job && job.companyId === c.id;
        }).length;
        return {
            // ── Company Details ──
            "Company Name": c.name || "N/A",
            "Industry": c.industry || "N/A",
            "Location / HQ": c.location || "N/A",
            "Full Address": c.address || "N/A",
            "Website": c.website || "N/A",
            "About": c.about || "N/A",
            // ── Recruitment Stats ──
            "Total Job Openings": companyJobs.length,
            "Open Positions": openJobs,
            "Closed Positions": closedJobs,
            "Total Candidates": totalCandidates,
            // ── Timestamps ──
            "Added Date": c.createdAt ? new Date(c.createdAt.seconds * 1000).toLocaleDateString() : "N/A"
        };
    });
    exportToExcel(data, "Companies_Report", "Companies");
};

window.fetchInterviewsReport = () => {
    const data = cachedInterviews.map(i => {
        const candidate = cachedCandidates.find(c => c.id === i.candidateId);
        const job = candidate ? cachedJobs.find(j => j.id === candidate.jobId) : null;
        const company = job ? cachedCompanies.find(co => co.id === job.companyId) : null;
        return {
            // ── Candidate Info ──
            "Candidate Name": candidate ? candidate.name : "N/A",
            "Candidate Phone": candidate ? (candidate.phone || "N/A") : "N/A",
            "Candidate Email": candidate ? (candidate.email || "N/A") : "N/A",
            "Current Company": candidate ? (candidate.currentCompany || "N/A") : "N/A",
            "Candidate Stage": candidate ? (candidate.stage || "N/A") : "N/A",
            // ── Interview Details ──
            "Interviewer": i.interviewer || "N/A",
            "Date & Time": i.dateTime ? i.dateTime.replace('T', ' ') : "N/A",
            "Mode": i.mode || "N/A",
            "Status": i.status || "Scheduled",
            "Meeting Link / Location": i.meetingLink || "N/A",
            "Feedback": i.feedback || "N/A",
            // ── Job & Company ──
            "Job Title": job ? (job.title || "N/A") : "N/A",
            "Department": job ? (job.department || "N/A") : "N/A",
            "Company": company ? company.name : "N/A"
        };
    });
    exportToExcel(data, "Interviews_Report", "Interviews");
};

window.fetchTemplatesReport = () => {
    const data = cachedWaTemplates.map(t => ({
        "Template Name": t.name || "N/A",
        "Category / Type": t.type || "N/A",
        "Content": t.content || "N/A",
        "Created Date": t.createdAt ? new Date(t.createdAt.seconds * 1000).toLocaleDateString() : "N/A",
        "Last Updated": t.updatedAt ? new Date(t.updatedAt.seconds * 1000).toLocaleDateString() : "N/A"
    }));
    exportToExcel(data, "Messaging_Templates_Report", "Templates");
};


window.deleteDocById = async (col, id) => {
    if (confirm("Are you sure you want to permanently delete this?")) {
        try {
            // INTERCEPT FOR INTERVIEWS: Revert candidate stage
            if (col === "interviews") {
                const interview = cachedInterviews.find(i => i.id === id);
                if (interview && interview.candidateId && interview.previousStage) {
                    const cand = cachedCandidates.find(c => c.id === interview.candidateId);
                    if (cand) {
                        // Only revert if they aren't already explicitly selected/rejected
                        if (cand.stage !== "Selected" && cand.stage !== "Rejected" && cand.stage !== "Backed Out" && cand.stage !== "Not Interested") {
                            await updateDoc(doc(db, "candidates", interview.candidateId), {
                                stage: interview.previousStage
                            });
                        }
                    }
                }
            }

            await deleteDoc(doc(db, col, id));
            showToast("Deleted Successfully");
        } catch (e) { alert("Error deleting: " + e.message); }
    }
};

// Helper to populate job select optionally filtered by department
window.populateCandidateJobs = function (department, includeJobId = null) {
    const jobSelect = document.getElementById('candidate-job-select');
    if (!jobSelect) return;

    // Recalculate active (open) jobs from fresh cached data
    const activeJobsForDropdown = cachedJobs.filter(j => {
        // If it's the specific job we need to include (even if closed), keep it
        if (includeJobId && j.id === includeJobId) return true;

        // Otherwise check if it's open (no closing date or closing date is in future)
        if (!j.closingDate) return true;
        const closeDate = new Date(j.closingDate);
        closeDate.setHours(23, 59, 59, 999);
        return new Date() <= closeDate;
    });

    // If no department is selected, we don't show any jobs
    if (!department) {
        jobSelect.innerHTML = '';
        const placeholderJob = document.createElement('option');
        placeholderJob.value = '';
        placeholderJob.disabled = true;
        placeholderJob.selected = true;
        placeholderJob.text = '-- Select Job --';
        jobSelect.appendChild(placeholderJob);
        return;
    }

    const jobsToShow = activeJobsForDropdown.filter(j => {
        return (j.department || '').toString() === department;
    });
    const prev = jobSelect.value;
    jobSelect.innerHTML = '';
    const placeholderJob = document.createElement('option');
    placeholderJob.value = '';
    placeholderJob.disabled = true;
    placeholderJob.selected = true;
    placeholderJob.text = '-- Select Job --';
    jobSelect.appendChild(placeholderJob);

    if (jobsToShow.length === 0) {
        const none = document.createElement('option'); none.value = ''; none.disabled = true; none.text = 'No active jobs in this department'; jobSelect.appendChild(none);
    } else {
        jobsToShow.forEach(j => {
            const opt = document.createElement('option'); opt.value = j.id; opt.text = j.title || j.id; jobSelect.appendChild(opt);
        });
    }

    // restore previous if still present
    if (prev) {
        const found = Array.from(jobSelect.options).find(o => o.value === prev);
        if (found) jobSelect.value = prev;
    }

    // Sync with custom UI
    try { initCustomSelects(); } catch (e) { console.warn('Sync failed in populateCandidateJobs', e); }
}

function updateDropdowns(includeCandidateJobId = null) {
    const companySelect = document.getElementById('job-company-select');
    const deptSelect = document.getElementById('candidate-job-dept-select');
    const searchList = document.getElementById('candidate-search-list');

    // Populate company select safely
    if (companySelect) {
        companySelect.innerHTML = '';
        // Placeholder option
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.disabled = true;
        placeholder.selected = true;
        placeholder.text = '-- Select Company --';
        companySelect.appendChild(placeholder);
        if (cachedCompanies.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.text = 'No companies available';
            companySelect.appendChild(opt);
        } else {
            cachedCompanies.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c.id;
                opt.text = c.name || c.id;
                companySelect.appendChild(opt);
            });
            // Ensure selecting a company prefills the Job Location when appropriate
            if (!companySelect.dataset.prefillHandler) {
                companySelect.addEventListener('change', prefillJobLocationFromCompany);
                companySelect.dataset.prefillHandler = '1';
            }
        }
    }

    if (deptSelect) {
        const depts = [...new Set(cachedJobs.map(j => j.department).filter(Boolean))];
        // preserve current value
        const current = deptSelect.value;
        deptSelect.innerHTML = '';
        const allOpt = document.createElement('option'); allOpt.value = ''; allOpt.text = '-- Select Department --'; deptSelect.appendChild(allOpt);
        depts.forEach(d => {
            const opt = document.createElement('option'); opt.value = d; opt.text = d; deptSelect.appendChild(opt);
        });
        if (current) deptSelect.value = current;
        // attach change handler once
        if (!deptSelect.dataset.handler) {
            deptSelect.addEventListener('change', () => {
                const currentCandId = document.getElementById('form-candidate-id').value;
                let candJobId = null;
                if (currentCandId) {
                    const c = cachedCandidates.find(x => x.id === currentCandId);
                    if (c) candJobId = c.jobId;
                }
                // repopulate jobs filtered by department
                window.populateCandidateJobs(deptSelect.value, candJobId);
            });
            deptSelect.dataset.handler = '1';
        }
    }

    // Sync Candidate Database Department Filter
    const candDeptFilter = document.getElementById('filter-candidate-dept');
    if (candDeptFilter) {
        const depts = [...new Set(cachedJobs.map(j => j.department).filter(Boolean))];
        const current = candDeptFilter.value;
        candDeptFilter.innerHTML = '<option value="all">All Depts</option>';
        depts.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d; opt.innerText = d;
            candDeptFilter.appendChild(opt);
        });
        if (current) candDeptFilter.value = current;
    }

    // initial populate for job select (respect dept filter if set)
    const deptVal = deptSelect ? deptSelect.value : '';
    window.populateCandidateJobs(deptVal, includeCandidateJobId);

    if (searchList) {
        searchList.innerHTML = '';
        cachedCandidates.forEach(c => {
            const opt = document.createElement('option');
            opt.value = `${c.name} | ${c.phone || ''} | ${c.email}`;
            opt.dataset.id = c.id;
            searchList.appendChild(opt);
        });
    }
    // Re-initialize custom selects so UI reflects new options
    try { initCustomSelects(); } catch (e) { console.warn('initCustomSelects error', e); }
}

// Convert native selects (single-select) into custom dropdowns for consistent rounded UI.
function initCustomSelects() {
    return; // Reverting to normal drop down filters as requested
    const selects = Array.from(document.querySelectorAll('select:not(.no-custom-select)'));

    selects.forEach(sel => {
        // skip multiple selects
        if (sel.multiple) return;

        // remove existing wrapper if present (rebuild on repopulate)
        const next = sel.nextElementSibling;
        if (next && next.classList && next.classList.contains('custom-select-wrapper')) {
            next.remove();
        }

        // hide native select visually but keep it focusable for validation
        sel.classList.add('visually-hidden');
        sel.dataset.customized = '1';

        const wrapper = document.createElement('div');
        wrapper.className = 'custom-select-wrapper';

        // Determine if this select should take full width based on its class
        if (sel.classList && (sel.classList.contains('theme-input') || sel.classList.contains('w-full'))) {
            wrapper.classList.add('w-full');
        }

        const display = document.createElement('div');
        display.className = 'custom-select-display';
        display.tabIndex = 0;
        display.setAttribute('role', 'button');
        display.setAttribute('aria-haspopup', 'listbox');
        display.setAttribute('aria-expanded', 'false');

        // Redirect focus from native select to custom display
        sel.addEventListener('focus', () => display.focus());
        const label = document.createElement('div'); label.className = 'label';
        const chev = document.createElement('div'); chev.innerHTML = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 8l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        display.appendChild(label);
        display.appendChild(chev);

        const optsBox = document.createElement('div');
        optsBox.className = 'custom-select-options hidden';
        optsBox.setAttribute('role', 'listbox');

        // Helper to create an option
        const createOpt = (o) => {
            const li = document.createElement('div');
            li.className = 'opt';
            li.dataset.value = o.value;
            li.innerText = o.text;
            li.tabIndex = o.disabled ? -1 : 0;
            li.setAttribute('role', 'option');
            if (o.disabled) {
                li.style.opacity = '0.6'; li.style.pointerEvents = 'none';
            }
            if (o.selected) {
                li.classList.add('active');
                label.innerText = o.text;
                li.setAttribute('aria-selected', 'true');
            }
            li.addEventListener('click', () => {
                sel.value = o.value;
                label.innerText = o.text;
                optsBox.querySelectorAll('.opt').forEach(x => { x.classList.remove('active'); x.removeAttribute('aria-selected'); });
                li.classList.add('active');
                li.setAttribute('aria-selected', 'true');
                optsBox.classList.add('hidden');
                display.setAttribute('aria-expanded', 'false');
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                if (sel.id === 'job-company-select') try { prefillJobLocationFromCompany(); } catch (e) { }
                display.focus();
            });
            li.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); li.click(); }
            });
            return li;
        };

        // populate options (handle optgroups if present)
        const children = Array.from(sel.children);
        children.forEach(child => {
            if (child.tagName === 'OPTGROUP') {
                const groupLabel = document.createElement('div');
                groupLabel.className = 'custom-select-group-label';
                groupLabel.innerText = child.label;
                optsBox.appendChild(groupLabel);
                Array.from(child.children).forEach(o => {
                    if (o.tagName === 'OPTION') optsBox.appendChild(createOpt(o));
                });
            } else if (child.tagName === 'OPTION') {
                optsBox.appendChild(createOpt(child));
            }
        });

        // If select is searchable, add an input to filter options
        if (sel.classList && sel.classList.contains('searchable-select')) {
            const searchWrap = document.createElement('div');
            searchWrap.style.padding = '0.5rem';
            const searchInput = document.createElement('input');
            searchInput.type = 'search';
            searchInput.placeholder = 'Search...';
            searchInput.className = 'theme-input rounded';
            searchInput.style.width = '100%';
            searchInput.style.marginBottom = '0.35rem';
            searchWrap.appendChild(searchInput);
            // insert at top
            optsBox.insertBefore(searchWrap, optsBox.firstChild);

            const noMatch = document.createElement('div');
            noMatch.className = 'opt';
            noMatch.style.opacity = '0.6';
            noMatch.style.pointerEvents = 'none';
            noMatch.innerText = 'No matches';
            noMatch.style.display = 'none';
            optsBox.appendChild(noMatch);

            const filter = () => {
                const q = (searchInput.value || '').trim().toLowerCase();
                let any = false;

                // Track grouped content
                let currentGroupLabel = null;
                let groupHasMatch = false;

                Array.from(optsBox.children).forEach(el => {
                    if (el.className === 'custom-select-group-label') {
                        // Previous group handling
                        if (currentGroupLabel && !groupHasMatch) currentGroupLabel.style.display = 'none';

                        currentGroupLabel = el;
                        groupHasMatch = false;
                        el.style.display = ''; // Reset for now
                    } else if (el.classList.contains('opt')) {
                        if (el === noMatch) return;
                        const txt = (el.innerText || '').toLowerCase();
                        const show = !q || txt.includes(q);
                        el.style.display = show ? '' : 'none';
                        if (show) {
                            any = true;
                            groupHasMatch = true;
                        }
                    }
                });
                // Final group check
                if (currentGroupLabel && !groupHasMatch && q) currentGroupLabel.style.display = 'none';

                noMatch.style.display = any ? 'none' : '';
            };

            searchInput.addEventListener('input', filter);
            // focus first visible option on ArrowDown
            searchInput.addEventListener('keydown', (ev) => {
                if (ev.key === 'ArrowDown') {
                    ev.preventDefault();
                    const first = optsBox.querySelector('.opt:not([style*="display: none"])');
                    if (first) first.focus();
                }
            });

            // Auto-focus search input when opened
            display.addEventListener('click', () => {
                if (!optsBox.classList.contains('hidden')) {
                    setTimeout(() => searchInput.focus(), 50);
                }
            });
        }

        // if none selected, show the currently selected option's text (or the first option)
        if (!label.innerText) {
            const currentOpt = sel.options[sel.selectedIndex] || sel.options[0];
            label.innerText = currentOpt ? currentOpt.text : '';
        }

        // toggle with click or keyboard
        const toggleOptions = (e) => {
            if (e) e.stopPropagation();
            const open = !optsBox.classList.contains('hidden');
            document.querySelectorAll('.custom-select-options').forEach(el => el.classList.add('hidden'));
            document.querySelectorAll('.custom-select-display').forEach(d => d.setAttribute('aria-expanded', 'false'));
            if (!open) {
                optsBox.classList.remove('hidden');
                display.setAttribute('aria-expanded', 'true');
                // focus first enabled option
                const first = optsBox.querySelector('.opt:not([style*="pointer-events: none"])');
                if (first) first.focus();
            } else {
                optsBox.classList.add('hidden');
                display.setAttribute('aria-expanded', 'false');
            }
        };

        display.addEventListener('click', toggleOptions);
        display.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleOptions(ev); }
            if (ev.key === 'ArrowDown') { ev.preventDefault(); if (optsBox.classList.contains('hidden')) toggleOptions(); else { const first = optsBox.querySelector('.opt:not([style*="pointer-events: none"])'); if (first) first.focus(); } }
        });

        // allow navigating options with arrow keys and Esc
        optsBox.addEventListener('keydown', (ev) => {
            const focusable = Array.from(optsBox.querySelectorAll('.opt')).filter(n => n.tabIndex >= 0);
            const idx = focusable.indexOf(document.activeElement);
            if (ev.key === 'ArrowDown') { ev.preventDefault(); const next = focusable[idx + 1] || focusable[0]; if (next) next.focus(); }
            if (ev.key === 'ArrowUp') { ev.preventDefault(); const prev = focusable[idx - 1] || focusable[focusable.length - 1]; if (prev) prev.focus(); }
            if (ev.key === 'Escape') { ev.preventDefault(); optsBox.classList.add('hidden'); display.setAttribute('aria-expanded', 'false'); display.focus(); }
        });

        // close on outside click (only when clicking outside this wrapper)
        window.addEventListener('click', (e) => { if (!wrapper.contains(e.target)) { optsBox.classList.add('hidden'); display.setAttribute('aria-expanded', 'false'); } });

        // prevent clicks inside optsBox from bubbling to window (so inputs inside stay interactive)
        optsBox.addEventListener('click', (e) => e.stopPropagation());

        wrapper.appendChild(display);
        wrapper.appendChild(optsBox);
        sel.parentNode.insertBefore(wrapper, sel.nextSibling);
    });
}

// Initialize custom selects once DOM is ready for interactive controls
setTimeout(() => { try { initCustomSelects(); } catch (e) { console.warn('initCustomSelects failed', e); } }, 300);

// Sidebar Collapse Logic
window.toggleSidebar = () => {
    const sidebar = document.getElementById('sidebar');
    if (sidebar) {
        sidebar.classList.toggle('sidebar-collapsed');
        localStorage.setItem('sidebar-collapsed', sidebar.classList.contains('sidebar-collapsed'));
    }
};

// Profile Menu Logic
window.toggleProfileMenu = (e) => {
    if (e) e.stopPropagation();
    const menu = document.getElementById('profile-menu');
    if (menu) {
        menu.classList.toggle('show');
    }
};

// Close dropdowns on outside click
window.addEventListener('click', (e) => {
    const menu = document.getElementById('profile-menu');
    if (menu && menu.classList.contains('show') && !e.target.closest('.profile-dropdown')) {
        menu.classList.remove('show');
    }
});

// Close dropdowns and active modals on Escape key
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        // Close profile menu if open
        const menu = document.getElementById('profile-menu');
        if (menu && menu.classList.contains('show')) {
            menu.classList.remove('show');
        }

        // Close any open modals
        const openModals = document.querySelectorAll('.fixed.inset-0:not(.hidden)');
        openModals.forEach(modal => {
            // Make sure it looks like a modal by checking if it has an ID, then attempt to close
            if (modal.id) {
                closeModal(modal.id);
            }
        });
    }
});

// Re-bind logout buttons including the one in navbar
const setupLogoutListeners = () => {
    const logoutBtns = ['btn-logout', 'nav-btn-logout'];
    logoutBtns.forEach(id => {
        const btn = document.getElementById(id);
        if (btn) {
            // Remove existing to avoid duplicates if any
            const newBtn = btn.cloneNode(true);
            btn.parentNode.replaceChild(newBtn, btn);
            newBtn.addEventListener('click', () => signOut(auth));
        }
    });
};

// Call after auth state change or in initApp
const originalInitApp = initApp;
initApp = async () => {
    await originalInitApp();
    setupLogoutListeners();

    // Restore sidebar state
    if (localStorage.getItem('sidebar-collapsed') === 'true') {
        const sidebar = document.getElementById('sidebar');
        if (sidebar) sidebar.classList.add('sidebar-collapsed');
    }
};

// ─── UTILS ───
window.showLoader = () => {
    const loader = document.getElementById('app-loader');
    if (loader) {
        // Cancel any pending hide
        if (loader._hideTimeout) {
            clearTimeout(loader._hideTimeout);
            loader._hideTimeout = null;
        }
        loader.classList.remove('hidden');
        // Force reflow so opacity transition always plays
        // eslint-disable-next-line no-unused-expressions
        loader.offsetHeight;
        loader.style.opacity = '1';
        loader.style.pointerEvents = 'auto';
    }
};

window.hideLoader = () => {
    const loader = document.getElementById('app-loader');
    if (loader) {
        loader.style.opacity = '0';
        loader.style.pointerEvents = 'none';
        // Clear any existing timeout to avoid overlaps if called rapidly
        if (loader._hideTimeout) clearTimeout(loader._hideTimeout);
        loader._hideTimeout = setTimeout(() => {
            loader.classList.add('hidden');
            loader._hideTimeout = null;
        }, 320);
    }
};

window.showSection = async (sectionId) => {
    // For normal navigation, only show the quick loader if initial data is already loaded.
    if (pendingInitialLoads === 0) {
        showLoader();
    }

    try {
        // Reduced delay for snappier feel
        await new Promise(resolve => setTimeout(resolve, 200));
        document.querySelectorAll('#content-area > div').forEach(div => div.classList.add('hidden'));
        const sectionEl = document.getElementById(`section-${sectionId}`);
        if (sectionEl) sectionEl.classList.remove('hidden');

        document.querySelectorAll('.sidebar-btn').forEach(btn => btn.classList.remove('sidebar-item-active'));
        const navBtn = document.getElementById(`btn-nav-${sectionId}`);
        if (navBtn) navBtn.classList.add('sidebar-item-active');

        const sectionInfo = {
            'dashboard': {
                title: 'Dashboard',
                subtitle: 'Quick overview of your recruitment activities',
                actions: [
                    { label: 'Add Candidate', icon: 'fa-user-plus', color: 'bg-blue-600', onclick: "openCandidateModal()" },
                    { label: 'Schedule Interview', icon: 'fa-calendar-plus', color: 'bg-purple-600', onclick: "openInterviewModal()" },

                    { label: 'Calculator', icon: 'fa-calculator', color: 'bg-slate-700', onclick: "toggleCalculator()" }
                ]
            },

            'companies': {
                title: 'Companies',
                subtitle: 'Manage partner companies and organizational info',
                actions: [
                    { label: 'Add Company', icon: 'fa-plus', color: 'bg-blue-600', onclick: "openCompanyModal()" },
                    { label: 'Calculator', icon: 'fa-calculator', color: 'bg-slate-700', onclick: "toggleCalculator()" }
                ]
            },
            'jobs': {
                title: 'Job Management',
                subtitle: 'Manage job openings and active listings',
                actions: [
                    { label: 'Create Job', icon: 'fa-plus', color: 'bg-blue-600', onclick: "openJobModal()" },
                    { label: 'Calculator', icon: 'fa-calculator', color: 'bg-slate-700', onclick: "toggleCalculator()" }
                ]
            },
            'candidates': {
                title: 'Candidate Database',
                subtitle: 'Unified view of all candidate profiles',
                actions: [
                    { label: 'Add Candidate', icon: 'fa-user-plus', color: 'bg-blue-600', onclick: "openCandidateModal()" },
                    { label: 'Calculator', icon: 'fa-calculator', color: 'bg-slate-700', onclick: "toggleCalculator()" }
                ]
            },
            'talentpool': {
                title: 'Manage Responses',
                subtitle: 'Track candidate responses across open positions',
                actions: [
                    { label: 'Post Job', icon: 'fa-plus', color: 'bg-blue-600', onclick: "showSection('jobs')" },
                    { label: 'Calculator', icon: 'fa-calculator', color: 'bg-slate-700', onclick: "toggleCalculator()" }
                ]
            },
            'interviews': {
                title: 'Interview Scheduler',
                subtitle: 'Coordinate and track candidate interviews',
                actions: [
                    { label: 'Schedule Interview', icon: 'fa-plus', color: 'bg-blue-600', onclick: "openInterviewModal()" },
                    { label: 'Calculator', icon: 'fa-calculator', color: 'bg-slate-700', onclick: "toggleCalculator()" }
                ]
            },
            'offers': {
                title: 'Offer Management',
                subtitle: 'Track and manage the final lifecycle of selection',
                actions: [
                    { label: 'Calculator', icon: 'fa-calculator', color: 'bg-slate-700', onclick: "toggleCalculator()" }
                ]
            },
            'messaging': {
                title: 'Communications',
                subtitle: 'Automate candidate messaging and templates',
                actions: [
                    { label: 'New Template', icon: 'fa-plus', color: 'bg-blue-600', onclick: "document.getElementById('form-wa-template').reset(); document.getElementById('form-wa-template-id').value = ''; document.getElementById('modal-wa-template-title').innerText = 'Create Messaging Template'; openModal('modal-wa-template')" },
                    { label: 'Calculator', icon: 'fa-calculator', color: 'bg-slate-700', onclick: "toggleCalculator()" }
                ]
            },
            'archive': {
                title: 'Success Archive',
                subtitle: 'Historical records for placements and positions',
                actions: [
                    { label: 'Export Archive', icon: 'fa-file-export', color: 'bg-blue-600', onclick: 'exportArchiveCSV()' },
                    { label: 'Calculator', icon: 'fa-calculator', color: 'bg-slate-700', onclick: "toggleCalculator()" }
                ]
            },
            'reports': {
                title: 'Reports & Data Export',
                subtitle: 'Analyze recruitment performance and export data',
                actions: [
                    { label: 'Calculator', icon: 'fa-calculator', color: 'bg-slate-700', onclick: "toggleCalculator()" }
                ]
            },
            'contacts': {
                title: 'Contacts & Dialer',
                subtitle: 'Manage talent network and initiate remote calls',
                actions: [
                    { label: 'Import Contacts', icon: 'fa-file-import', color: 'bg-indigo-600', onclick: "showToast('Importing contacts...')" },
                    { label: 'Calculator', icon: 'fa-calculator', color: 'bg-slate-700', onclick: "toggleCalculator()" }
                ]
            },
            'portalsettings': {
                title: 'Public Portal Settings',
                subtitle: 'Configure how candidates see your career page',
                actions: [
                    { label: 'Calculator', icon: 'fa-calculator', color: 'bg-slate-700', onclick: "toggleCalculator()" }
                ]
            }
        };


        const info = sectionInfo[sectionId] || { title: (sectionId.charAt(0).toUpperCase() + sectionId.slice(1)), subtitle: '', actions: [] };
        const titleEl = document.getElementById('section-title');
        const subtitleEl = document.getElementById('section-subtitle');

        if (titleEl) titleEl.innerText = info.title;
        if (subtitleEl) subtitleEl.innerText = info.subtitle;

        // Update FAB
        updateFAB(info.actions || []);

        // Ensure the visible section is rendered/refreshed so filters take effect
        switch (sectionId) {
            case 'dashboard':
                updateDashboard();
                break;

            case 'companies':
                renderCompanies();
                break;
            case 'jobs':
                renderJobs();
                break;
            case 'candidates':
                renderCandidates();
                renderWaCandidatesChecklist();
                break;
            case 'talentpool':
                renderTalentPool();
                break;
            case 'archive':
                renderArchive();
                break;
            case 'interviews':
                renderInterviews();
                break;
            case 'offers':
                renderOffers();
                break;
            case 'messaging':
                renderWaCandidatesChecklist();
                previewSelectedTemplate();
                break;
            case 'reports':
                updateDashboard();
                break;
            case 'portalsettings':
                loadPortalSettings();
                break;
            case 'contacts':
                renderContactsSection();
                break;
            default:
                break;

        }

        if (pendingInitialLoads === 0) {
            hideLoader();
        }

    } catch (error) {
        console.error("Error showing section:", error);

    }
};


window.toggleFAB = () => {
    const mainBtn = document.getElementById('fab-main');
    const menuEl = document.getElementById('fab-menu');
    if (mainBtn && menuEl) {
        mainBtn.classList.toggle('active');
        menuEl.classList.toggle('active');
    }
};

function updateFAB(actions) {
    const fabContainer = document.getElementById('fab-container');
    const fabMenu = document.getElementById('fab-menu');
    const fabMain = document.getElementById('fab-main');

    if (!fabContainer || !fabMenu || !fabMain) return;

    if (!actions || actions.length === 0) {
        fabContainer.classList.add('hidden');
        return;
    }

    fabContainer.classList.remove('hidden');
    fabMain.classList.remove('active');
    fabMenu.classList.remove('active');

    fabMenu.innerHTML = actions.map((action, index) => `
        <div class="fab-item" onclick="${action.onclick}; toggleFAB();" style="transition-delay: ${index * 50}ms">
            <span class="fab-label">${action.label}</span>
            <button class="fab-button ${action.color}">
                <i class="fas ${action.icon}"></i>
            </button>
        </div>
    `).join('');
}


window.openModal = (id) => document.getElementById(id).classList.remove('hidden');
window.closeModal = (id) => document.getElementById(id).classList.add('hidden');

function showToast(msg) {
    const t = document.getElementById('toast');
    t.innerText = msg;
    t.classList.remove('opacity-0', 'bg-slate-800');
    t.classList.add('opacity-100', 'bg-blue-600');
    // User requested 2-3 seconds
    setTimeout(() => {
        t.classList.add('opacity-0');
        t.classList.remove('opacity-100');
    }, 2500);
}

function showError(msg) {
    const err = document.getElementById('auth-error');
    if (err) {
        err.innerText = getFriendlyErrorMessage(msg);
        err.classList.remove('hidden');
    }
}

function getFriendlyErrorMessage(msg) {
    if (!msg) return "An unknown error occurred.";

    if (msg.includes('auth/invalid-credential') ||
        msg.includes('auth/user-not-found') ||
        msg.includes('auth/wrong-password')) {
        return "Invalid email or password. Please try again.";
    } else if (msg.includes('auth/invalid-email')) {
        return "Please enter a valid email address.";
    } else if (msg.includes('auth/network-request-failed')) {
        return "Network error. Please check your connection.";
    } else if (msg.includes('auth/too-many-requests')) {
        return "Too many failed attempts. Please try again later.";
    } else if (msg.includes('auth/user-disabled')) {
        return "This account has been disabled.";
    }

    return msg; // Fallback to original message if not mapped
}

document.getElementById('filter-budget').onchange = renderCandidates;

// Theme Toggle Logic
const themeToggle = document.getElementById('theme-toggle');
if (themeToggle) {
    themeToggle.addEventListener('click', () => {
        const isDark = document.documentElement.classList.toggle('dark');
        localStorage.setItem('theme', isDark ? 'dark' : 'light');

        // Update charts if they exist
        if (stageChartInstance) updateChartTheme(stageChartInstance);
        if (budgetChartInstance) updateChartTheme(budgetChartInstance);
        if (sourceChartInstance) updateChartTheme(sourceChartInstance);
    });
}

function updateChartTheme(chart) {
    // Optional: deep chart theme update if needed
    // For now, the CSS filter handles it enough
    chart.update();
}

// Expose functions to global scope for inline handlers
window.renderJobs = renderJobs;
window.renderCandidates = renderCandidates;
window.renderCompanies = renderCompanies;
window.updateDropdowns = updateDropdowns;
window.renderInterviews = renderInterviews;
window.updateDashboard = updateDashboard;
window.renderWaTemplates = renderWaTemplates;
window.renderWaCandidatesChecklist = renderWaCandidatesChecklist;
window.updateWaDropdowns = updateWaDropdowns;
// expose new candidate utilities for inline handlers
window.toggleCandidateView = toggleCandidateView;
window.exportCandidatesCSV = exportCandidatesCSV;
window.bulkSelectAndMessage = bulkSelectAndMessage;

window.openAddInterviewModal = () => {
    const form = document.getElementById('form-interview');
    if (form) form.reset();
    const idField = document.getElementById('form-interview-id');
    if (idField) idField.value = '';
    const title = document.getElementById('modal-interview-title');
    if (title) title.innerText = 'Schedule Interview';
    const searchField = document.getElementById('interview-candidate-search');
    if (searchField) searchField.value = '';
    const hiddenId = document.getElementById('interview-candidate-id-hidden');
    if (hiddenId) hiddenId.value = '';
    openModal('modal-interview');
};













window.renderOffers = () => {
    const list = document.getElementById('offers-list');
    if (!list) return;

    // Update Top Summary Stats
    const totalOffers = cachedOffers.length;
    const pendingOffers = cachedOffers.filter(o => (o.status || 'Pending') === 'Pending').length;
    const sentOffers = cachedOffers.filter(o => o.status === 'Sent').length;
    const signedOffers = cachedOffers.filter(o => o.status === 'Signed').length;

    if (document.getElementById('offer-stat-total')) document.getElementById('offer-stat-total').innerText = totalOffers;
    if (document.getElementById('offer-stat-pending')) document.getElementById('offer-stat-pending').innerText = pendingOffers;
    if (document.getElementById('offer-stat-sent')) document.getElementById('offer-stat-sent').innerText = sentOffers;
    if (document.getElementById('offer-stat-signed')) document.getElementById('offer-stat-signed').innerText = signedOffers;

    const searchTerm = getEffectiveQuery('offers');

    let filteredOffers = cachedOffers;
    if (currentOfferFilter !== 'all') {
        filteredOffers = filteredOffers.filter(o => (o.status || 'Pending') === currentOfferFilter);
    }

    if (searchTerm) {
        filteredOffers = filteredOffers.filter(o =>
            (o.candidateName || '').toLowerCase().includes(searchTerm) ||
            (o.jobTitle || '').toLowerCase().includes(searchTerm)
        );
    }

    if (filteredOffers.length === 0) {
        list.innerHTML = `
            <div class="col-span-full py-16 text-center animate-fade-up">
                <div class="w-16 h-16 bg-slate-100 dark:bg-slate-800 rounded-full flex items-center justify-center mx-auto mb-4 text-slate-300">
                    <i class="fas fa-inbox text-2xl"></i>
                </div>
                <h4 class="text-slate-400 font-bold mb-1">No offers found</h4>
                <p class="text-slate-500 text-xs">Try changing filters or searching for someone else.</p>
            </div>`;
        return;
    }

    list.innerHTML = filteredOffers.map((o, idx) => {
        const cand = cachedCandidates.find(c => c.id === o.candidateId);
        const job = cachedJobs.find(j => j.id === o.jobId);
        const status = o.status || 'Pending';

        const statusConfig = {
            'Pending': { icon: 'fa-clock', color: 'orange', label: 'Preparation' },
            'Sent': { icon: 'fa-paper-plane', color: 'indigo', label: 'Offer Sent' },
            'Signed': { icon: 'fa-file-signature', color: 'emerald', label: 'Completed' }
        }[status] || { icon: 'fa-circle', color: 'slate', label: status };

        const initials = (o.candidateName || '?')[0].toUpperCase();
        const ctc = o.offeredCTC ? `₹${Number(o.offeredCTC).toLocaleString('en-IN')}` : 'TBD';

        return `
            <div class="glass-card p-6 rounded-3xl border border-slate-200 dark:border-slate-800 hover:shadow-2xl hover:shadow-blue-500/10 transition-all group animate-fade-up relative" style="animation-delay: ${idx * 0.05}s">
                <!-- Checkbox for Bulk Selection -->
                <div class="absolute top-5 left-5 z-10 opacity-0 group-hover:opacity-100 has-[:checked]:opacity-100 transition-all">
                    <label for="offer-check-${o.id}" class="sr-only">Select offer for ${o.candidateName}</label>
                    <input type="checkbox" id="offer-check-${o.id}" name="offer-check" value="${o.id}" class="w-5 h-5 rounded-lg border-slate-300 text-blue-600 transition-all cursor-pointer shadow-sm">
                </div>

                <!-- Status Header -->
                <div class="flex justify-between items-start mb-5 ml-2">
                    <div class="flex items-center gap-3">
                        <div class="w-12 h-12 rounded-2xl bg-${statusConfig.color}-50 dark:bg-${statusConfig.color}-900/20 flex items-center justify-center font-black text-${statusConfig.color}-600 text-xl shadow-sm italic">
                            ${initials}
                        </div>
                        <div>
                            <h4 class="font-bold text-slate-800 dark:text-white leading-tight">${highlight(o.candidateName || 'Unknown', searchTerm)}</h4>
                            <p class="text-[10px] text-slate-400 uppercase font-black tracking-widest mt-0.5">${statusConfig.label}</p>
                        </div>
                    </div>
                    <div class="p-2.5 rounded-xl bg-${statusConfig.color}-100/50 dark:bg-${statusConfig.color}-900/40 text-${statusConfig.color}-600">
                        <i class="fas ${statusConfig.icon}"></i>
                    </div>
                </div>

                <!-- Job Info -->
                <div class="space-y-3 mb-6 bg-slate-50/50 dark:bg-slate-900/30 p-4 rounded-2xl border border-slate-100 dark:border-slate-800/50">
                    <div class="flex items-center gap-3">
                        <i class="fas fa-briefcase text-xs text-slate-400 w-4"></i>
                        <span class="text-xs font-bold text-slate-600 dark:text-white truncate">${o.jobTitle || 'Position Unknown'}</span>
                    </div>
                    <div class="flex items-center gap-3">
                        <i class="fas fa-layer-group text-xs text-slate-400 w-4"></i>
                        <span class="text-[10px] font-semibold text-slate-500">${job?.department || 'N/A'} • ${job?.location || 'Remote'}</span>
                    </div>
                    <div class="pt-2 mt-2 border-t border-slate-200/50 dark:border-slate-800 flex justify-between items-center">
                        <span class="text-[10px] font-bold text-slate-400 uppercase">Monthly Package</span>
                        <span class="text-sm font-black text-${statusConfig.color}-600">${ctc}<span class="text-[9px] font-semibold opacity-60">/mo</span></span>
                    </div>
                </div>

                <!-- Progress Tracker -->
                <div class="px-2 mb-6">
                    <div class="h-1.5 w-full bg-slate-100 dark:bg-slate-800 rounded-full flex gap-1.5 p-0.5">
                        <div class="flex-1 rounded-full ${status === 'Pending' ? 'bg-orange-400 animate-pulse' : 'bg-emerald-500'}"></div>
                        <div class="flex-1 rounded-full ${status === 'Sent' ? 'bg-indigo-500 animate-pulse' : (status === 'Signed' ? 'bg-emerald-500' : 'bg-slate-200 dark:bg-slate-700')}"></div>
                        <div class="flex-1 rounded-full ${status === 'Signed' ? 'bg-emerald-500' : 'bg-slate-200 dark:bg-slate-700'}"></div>
                    </div>
                </div>

                <!-- Actions -->
                <div class="flex flex-col gap-2">
                    <div class="flex gap-2">
                        <button onclick="sendOfferWhatsApp('${o.id}')" class="flex-1 py-2 rounded-xl bg-[#25D366]/10 text-[#25D366] hover:bg-[#25D366] hover:text-white transition-all text-[10px] font-bold uppercase flex items-center justify-center gap-2">
                            <i class="fab fa-whatsapp"></i> WhatsApp
                        </button>
                        <button onclick="sendOfferEmail('${o.id}')" class="flex-1 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-all text-[10px] font-bold uppercase flex items-center justify-center gap-2">
                            <i class="fas fa-envelope"></i> Email
                        </button>
                    </div>
                    
                    ${status === 'Pending' ? `
                        <button onclick="updateOfferStatus('${o.id}', 'Sent')" class="w-full py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-[11px] font-black uppercase tracking-widest shadow-xl shadow-indigo-500/20 transition-all transform active:scale-95 flex items-center justify-center gap-2">
                            Next Stage: Dispatch <i class="fas fa-arrow-right"></i>
                        </button>
                    ` : ''}
                    ${status === 'Sent' ? `
                        <button onclick="updateOfferStatus('${o.id}', 'Signed')" class="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-[11px] font-black uppercase tracking-widest shadow-xl shadow-emerald-500/20 transition-all transform active:scale-95 flex items-center justify-center gap-2">
                            Candidate Signed <i class="fas fa-check-double"></i>
                        </button>
                    ` : ''}
                    ${status === 'Signed' ? `
                        <div class="w-full py-3 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 text-[11px] font-black uppercase tracking-widest rounded-xl flex items-center justify-center border border-emerald-100 dark:border-emerald-800/50">
                            Offer Completed <i class="fas fa-check-circle ml-2"></i>
                        </div>
                    ` : ''}
                </div>
            </div>`;
    }).join('');
};

window.sendOfferWhatsApp = (id) => {
    const o = cachedOffers.find(x => x.id === id);
    const cand = cachedCandidates.find(c => c.id === o?.candidateId);
    if (!cand || !cand.phone) return showToast("No phone number registered", "error");

    const message = `Dear ${cand.name}, we are pleased to inform you that we've forwarded your offer letter for the ${o.jobTitle} position. Please check your email. Looking forward to having you on the team!`;
    const url = `https://wa.me/${cand.phone.replace(/[^0-9]/g, '')}?text=${encodeURIComponent(message)}`;
    window.open(url, '_blank');
};

window.sendOfferEmail = (id) => {
    const o = cachedOffers.find(x => x.id === id);
    const cand = cachedCandidates.find(c => c.id === o?.candidateId);
    if (!cand || !cand.email) return showToast("No email registered", "error");

    const subject = `Offer Letter - ${o.jobTitle} | Recruitment Team`;
    const body = `Dear ${cand.name},\n\nWe are excited to share your offer letter for the position of ${o.jobTitle}. Please find the details attached.\n\nBest Regards,\nRecruitment Team`;
    const url = `mailto:${cand.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.open(url, '_blank');
};

window.updateOfferStatus = async (id, status) => {
    try {
        await updateDoc(doc(db, "offers", id), {
            status: status,
            updatedAt: serverTimestamp()
        });

        // Automation: If offer is SENT, move candidate to HIRED
        if (status === 'Sent') {
            const offer = cachedOffers.find(o => o.id === id);
            if (offer && offer.candidateId) {
                await updateDoc(doc(db, "candidates", offer.candidateId), {
                    stage: 'Hired',
                    hiredAt: serverTimestamp(),
                    updatedAt: serverTimestamp()
                });
                showToast("Candidate marked as HIRED!");
            }
        }

        showToast(status);
        renderOffers();
    } catch (e) {
        showError("Failed");
    }
};

window.loadPortalSettings = async () => {
    const container = document.getElementById('portal-settings-container');
    if (!container) return;
    try {
        const docSnap = await getDoc(doc(db, "settings", "publicPortal"));
        const data = {
            primaryColor: '#3b82f6',
            isLocked: false,
            logoUrl: '',
            backgroundUrl: '',
            fontFamily: 'Plus Jakarta Sans, sans-serif',
            companyName: 'Brawn Laboratories Ltd', // Default Brand Name
            jobsDisplayMode: 'All',
            selectedJobsList: [],
            customCtaText: 'Apply Now',
            ...(docSnap.exists() ? docSnap.data() : {})
        };

        container.innerHTML = `
                <form id="form-portal-settings" class="w-full space-y-6">
                    <div class="glass-card p-8 rounded-3xl border border-slate-200 shadow-xl space-y-8">
                        
                        <!-- Header & Master Toggle -->
                        <div class="flex flex-col md:flex-row md:items-center justify-between gap-6 border-b pb-6 border-slate-100 dark:border-slate-800">
                            <div>
                                <h4 class="text-xl font-bold flex items-center gap-2">
                                    <i class="fas fa-tower-broadcast text-blue-500"></i> Public Portal Configuration
                                </h4>
                                <p class="text-sm text-slate-500 mt-1">Manage branding, visibility, and access for your public career page.</p>
                                <div class="mt-3 flex items-center gap-3">
                                    <a href="Candidate/" target="_blank" class="text-xs font-bold text-blue-600 hover:underline flex items-center gap-1.5 bg-blue-50 dark:bg-blue-900/30 px-3 py-1.5 rounded-lg border border-blue-100 dark:border-blue-800 transition-all">
                                        <i class="fas fa-external-link-alt"></i> View Live Portal
                                    </a>
                                    <span class="text-[10px] font-mono text-slate-400 opacity-70">./Candidate/</span>
                                </div>
                            </div>
                            <div class="flex items-center gap-4 bg-slate-50 dark:bg-slate-800/50 p-3 rounded-2xl border border-slate-100 dark:border-slate-800">
                                <span class="text-xs font-bold uppercase tracking-widest text-slate-400">Portal Status</span>
                                <label for="portal-is-locked" class="relative inline-flex items-center cursor-pointer">
                                    <input type="checkbox" id="portal-is-locked" name="isLocked" class="sr-only peer" ${data.isLocked ? 'checked' : ''}>
                                    <div class="w-14 h-7 bg-slate-200 peer-focus:outline-none rounded-full peer dark:bg-slate-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[4px] after:left-[4px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-red-500"></div>
                                    <span class="ml-4 text-sm font-extrabold ${data.isLocked ? 'text-red-500' : 'text-green-500'} tracking-wide">${data.isLocked ? 'LOCKED' : 'ACTIVE'}</span>
                                </label>
                            </div>
                        </div>

                        <div class="grid grid-cols-1 lg:grid-cols-2 gap-10">
                            <!-- Left Column: Branding -->
                            <div class="space-y-6">
                                <div>
                                    <h4 class="font-bold text-slate-700 dark:text-slate-300 flex items-center gap-2 mb-1">
                                        <i class="fas fa-palette text-blue-500"></i> Visual Branding
                                    </h4>
                                    <p class="text-xs text-slate-400">Customize the look and feel of your candidate experience.</p>
                                </div>
                                <div class="space-y-1.5">
                                    <label for="portal-primary-color" class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">Theme Color</label>
                                    <div class="flex items-center gap-3">
                                        <input type="color" id="portal-primary-color" name="primaryColor" value="${data.primaryColor || '#3b82f6'}" class="h-10 w-16 p-1 rounded cursor-pointer theme-input">
                                        <input type="text" value="${data.primaryColor || '#3b82f6'}" class="theme-input flex-1 font-mono text-xs uppercase" readonly aria-label="Hex color value">
                                    </div>
                                </div>
                                <div class="space-y-1.5">
                                    <label for="portal-cta-text" class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">Custom Apply CTA Text</label>
                                    <input type="text" id="portal-cta-text" name="customCtaText" value="${data.customCtaText || 'Apply Now'}" placeholder="e.g. Join the Team" class="theme-input" autocomplete="off">
                                </div>
                            </div>

                            <!-- Right Column: Visibility & Content -->
                            <div class="space-y-6">
                                <h4 class="font-bold text-slate-700 dark:text-slate-300 flex items-center gap-2">
                                    <i class="fas fa-filter text-blue-500"></i> Exposure & Content
                                </h4>
                                
                                <div class="space-y-3">
                                    <label for="portal-about" class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">About the Company (Intro text)</label>
                                    <textarea id="portal-about" name="aboutCompany" class="theme-input min-h-[100px] text-sm leading-relaxed" placeholder="Share a few lines about your culture and mission...">${data.aboutCompany || ''}</textarea>
                                </div>

                                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                    <div class="space-y-1.5">
                                        <label for="portal-support-email" class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">Support Email</label>
                                        <input type="email" id="portal-support-email" name="supportEmail" value="${data.supportEmail || ''}" placeholder="careers@brand.com" class="theme-input" autocomplete="email">
                                    </div>
                                    <div class="space-y-1.5">
                                        <label for="portal-support-phone" class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">Support Phone</label>
                                        <input type="text" id="portal-support-phone" name="supportPhone" value="${data.supportPhone || ''}" placeholder="+91..." class="theme-input" autocomplete="tel">
                                    </div>
                                </div>

                                <!-- Social Links -->
                                <div class="space-y-3">
                                    <label for="portal-linkedin" class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">Social Footprint</label>
                                    <div class="space-y-2">
                                        <div class="relative">
                                            <i class="fab fa-linkedin absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"></i>
                                            <input type="text" id="portal-linkedin" name="socialLinkedin" value="${data.socialLinkedin || ''}" placeholder="LinkedIn URL" class="theme-input !pl-10" autocomplete="url">
                                        </div>
                                    </div>
                                </div>

                                <!-- Relocated below -->

                            </div>
                        </div>

                        <!-- Jobs Display Configuration (Full Width) -->
                        <div class="space-y-5 pt-8 mt-4 border-t border-slate-100 dark:border-slate-800">
                            <div class="mb-2">
                                <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2"><i class="fas fa-filter text-blue-500"></i> Portal Job Filters</label>
                                <p class="text-[10px] mt-1 text-slate-500 leading-relaxed">Control which jobs are visible on the candidate portal in detail.</p>
                            </div>
                            
                            <div class="space-y-2 max-w-sm">
                                <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">Visibility Rule</label>
                                <select id="portal-jobs-mode" name="jobsDisplayMode" class="theme-input text-sm font-bold" onchange="
                                    document.getElementById('portal-jobs-rules').classList.toggle('hidden', this.value !== 'Rules');
                                    document.getElementById('portal-jobs-selection').classList.toggle('hidden', this.value !== 'Selected');
                                ">
                                    <option value="All" ${data.jobsDisplayMode === 'All' || !data.jobsDisplayMode ? 'selected' : ''}>Show All Active Jobs</option>
                                    <option value="Rules" ${data.jobsDisplayMode === 'Rules' ? 'selected' : ''}>Filter by Department / Location</option>
                                    <option value="Selected" ${data.jobsDisplayMode === 'Selected' ? 'selected' : ''}>Manually Select Specific Jobs</option>
                                </select>
                            </div>

                            <!-- Rules Configuration -->
                            <div id="portal-jobs-rules" class="space-y-4 p-5 bg-slate-50 dark:bg-slate-800/40 rounded-2xl border border-slate-100 dark:border-slate-800 ${data.jobsDisplayMode === 'Rules' ? '' : 'hidden'}">
                                <div>
                                    <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">Allowed Departments</label>
                                    <div class="flex flex-wrap gap-2.5">
                                        ${[...new Set(cachedJobs.filter(j => j.status === 'Open').map(j => j.department).filter(Boolean))].map(d => `
                                            <label class="flex items-center gap-2 cursor-pointer text-xs bg-white dark:bg-slate-900 px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm transition-all hover:border-blue-400 hover:shadow-md">
                                                <input type="checkbox" name="jobsFilterDepts" value="${d}" ${data.jobsFilterDepts?.includes(d) ? 'checked' : ''} class="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500">
                                                <span class="text-slate-700 dark:text-slate-300 font-bold">${d}</span>
                                            </label>
                                        `).join('') || '<span class="text-xs text-slate-400 italic">No departments available</span>'}
                                    </div>
                                </div>
                                <div>
                                    <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3 pt-2">Allowed Locations</label>
                                    <div class="flex flex-wrap gap-2.5">
                                        ${[...new Set(cachedJobs.filter(j => j.status === 'Open').map(j => j.location).filter(Boolean))].map(l => `
                                            <label class="flex items-center gap-2 cursor-pointer text-xs bg-white dark:bg-slate-900 px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm transition-all hover:border-blue-400 hover:shadow-md">
                                                <input type="checkbox" name="jobsFilterLocs" value="${l}" ${data.jobsFilterLocs?.includes(l) ? 'checked' : ''} class="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500">
                                                <span class="text-slate-700 dark:text-slate-300 font-bold">${l}</span>
                                            </label>
                                        `).join('') || '<span class="text-xs text-slate-400 italic">No locations available</span>'}
                                    </div>
                                </div>
                                <p class="text-[9px] text-slate-500 pt-3 border-t border-slate-200 dark:border-slate-700 uppercase font-black tracking-wider">Note: Jobs must match selected departments AND locations. If empty, all are shown.</p>
                            </div>

                            <!-- Manual Selection (Enhanced) -->
                            <div id="portal-jobs-selection" class="space-y-4 p-5 bg-slate-50 dark:bg-slate-800/40 rounded-2xl border border-slate-100 dark:border-slate-800 ${data.jobsDisplayMode === 'Selected' ? '' : 'hidden'}">
                                
                                <div class="flex flex-col md:flex-row gap-4 mb-2">
                                    <div class="flex-1 relative">
                                        <i class="fas fa-search absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm"></i>
                                        <input type="text" id="manual-job-search" placeholder="Search by job title..." class="theme-input !pl-10 text-sm font-bold h-11" onkeyup="filterPortalManualJobs()">
                                    </div>
                                    <select id="manual-job-dept" class="theme-input text-sm md:w-56 font-bold h-11" onchange="filterPortalManualJobs()">
                                        <option value="">All Departments</option>
                                        ${[...new Set(cachedJobs.filter(j => j.status === 'Open').map(j => j.department).filter(Boolean))].map(d => `<option value="${d}">${d}</option>`).join('')}
                                    </select>
                                    <select id="manual-job-loc" class="theme-input text-sm md:w-56 font-bold h-11" onchange="filterPortalManualJobs()">
                                        <option value="">All Locations</option>
                                        ${[...new Set(cachedJobs.filter(j => j.status === 'Open').map(j => j.location).filter(Boolean))].map(l => `<option value="${l}">${l}</option>`).join('')}
                                    </select>
                                </div>
                                
                                <div class="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-700">
                                    <label class="text-xs font-bold text-slate-600 dark:text-slate-400 flex items-center gap-2 cursor-pointer hover:text-blue-600 transition-colors">
                                        <input type="checkbox" id="manual-job-select-all" class="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" onchange="toggleAllManualJobs(this.checked)">
                                        Select All Visible Match
                                    </label>
                                    <span class="text-[10px] font-black text-slate-400 uppercase tracking-widest bg-white dark:bg-slate-900 px-3 py-1 rounded-full shadow-sm border border-slate-200 dark:border-slate-700" id="manual-job-count">Showing ${cachedJobs.filter(j => j.status === 'Open').length} jobs</span>
                                </div>
                                
                                <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 max-h-[300px] overflow-y-auto pr-2 custom-scrollbar" id="manual-jobs-list">
                                    ${cachedJobs.filter(j => j.status === 'Open').map(j => `
                                        <label class="manual-job-item flex items-start gap-3 py-2 cursor-pointer bg-white dark:bg-slate-900 p-3.5 rounded-xl transition-all border border-slate-200 dark:border-slate-700 shadow-sm hover:border-blue-400 group" data-title="${(j.title || '').toLowerCase()}" data-dept="${j.department || ''}" data-loc="${j.location || ''}">
                                            <input type="checkbox" name="selectedJobsList" value="${j.id}" ${data.selectedJobsList?.includes(j.id) ? 'checked' : ''} class="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 mt-0.5 transition-transform group-hover:scale-110" onchange="updateManualJobSelectAll()">
                                            <div class="flex flex-col flex-1 min-w-0">
                                                <span class="text-xs font-black text-slate-800 dark:text-slate-200 leading-tight truncate" title="${j.title}">${j.title}</span>
                                                <span class="text-[9px] font-bold text-slate-500 uppercase mt-1.5 flex items-center gap-1.5 truncate"><i class="fas fa-layer-group text-slate-400 w-3 text-center"></i> ${j.department || 'General'}</span>
                                                <span class="text-[9px] font-bold text-slate-500 uppercase mt-0.5 flex items-center gap-1.5 truncate"><i class="fas fa-location-dot text-slate-400 w-3 text-center"></i> ${j.location || 'Remote'}</span>
                                            </div>
                                        </label>
                                    `).join('')}
                                    ${cachedJobs.filter(j => j.status === 'Open').length === 0 ? '<p class="text-xs text-red-500 font-bold col-span-full">No active jobs found.</p>' : ''}
                                </div>
                            </div>
                        </div>

                        <div class="pt-8 border-t border-slate-100 dark:border-slate-800">
                            <button type="submit" class="w-full bg-blue-600 hover:bg-blue-700 text-white py-4 rounded-2xl font-bold shadow-xl shadow-blue-600/20 transition-all active:scale-[0.98] flex items-center justify-center gap-3">
                                <i class="fas fa-save shadow-sm"></i>
                                Save & Synchronize Public Portal
                            </button>
                        </div>
                    </div>
                </form>`;

        window.filterPortalManualJobs = () => {
            const search = document.getElementById('manual-job-search').value.toLowerCase();
            const dept = document.getElementById('manual-job-dept').value;
            const loc = document.getElementById('manual-job-loc').value;
            const items = document.querySelectorAll('.manual-job-item');
            let count = 0;

            items.forEach(item => {
                const iTitle = item.getAttribute('data-title');
                const iDept = item.getAttribute('data-dept');
                const iLoc = item.getAttribute('data-loc');

                const matchSearch = iTitle.includes(search);
                const matchDept = !dept || iDept === dept;
                const matchLoc = !loc || iLoc === loc;

                if (matchSearch && matchDept && matchLoc) {
                    item.style.display = 'flex';
                    count++;
                } else {
                    item.style.display = 'none';
                }
            });

            const countEl = document.getElementById('manual-job-count');
            if (countEl) countEl.innerText = `Showing ${count} jobs`;
            window.updateManualJobSelectAll();
        };

        window.toggleAllManualJobs = (checked) => {
            const items = document.querySelectorAll('.manual-job-item');
            items.forEach(item => {
                if (item.style.display !== 'none') {
                    const cb = item.querySelector('input[type="checkbox"]');
                    if (cb) cb.checked = checked;
                }
            });
            window.updateManualJobSelectAll();
        };

        window.updateManualJobSelectAll = () => {
            const items = document.querySelectorAll('.manual-job-item');
            let allChecked = true;
            let anyVisible = false;
            items.forEach(item => {
                if (item.style.display !== 'none') {
                    anyVisible = true;
                    const cb = item.querySelector('input[type="checkbox"]');
                    if (cb && !cb.checked) allChecked = false;
                }
            });
            const master = document.getElementById('manual-job-select-all');
            if (master) {
                master.checked = anyVisible && allChecked;
            }
        };

        // Initialize state on render
        setTimeout(() => { if (document.getElementById('manual-job-select-all')) window.updateManualJobSelectAll(); }, 50);

        document.getElementById('form-portal-settings').onsubmit = async (e) => {
            e.preventDefault();
            const fd = new FormData(e.target);

            const s = {
                primaryColor: fd.get('primaryColor'),
                customCtaText: fd.get('customCtaText'),
                // UX fields removed as per request
                aboutCompany: fd.get('aboutCompany'),
                supportEmail: fd.get('supportEmail'),
                supportPhone: fd.get('supportPhone'),
                socialLinkedin: fd.get('socialLinkedin'),
                jobsDisplayMode: fd.get('jobsDisplayMode'),
                jobsFilterDepts: fd.getAll('jobsFilterDepts'),
                jobsFilterLocs: fd.getAll('jobsFilterLocs'),
                selectedJobsList: fd.getAll('selectedJobsList'),
                isLocked: e.target.querySelector('input[name="isLocked"]').checked,
                updatedAt: serverTimestamp()
            };

            try {
                await setDoc(doc(db, "settings", "publicPortal"), s);
                showToast("Portal Synchronized Successfully");
                loadPortalSettings();
            } catch (e) {
                showError("Load failed");
            }
        };
    } catch (e) {
        console.error("Portal Load Error:", e);
        showError("Load failed");
    }
};

// --- POLYMORPHIC PROFILE VIEW LOGIC ---
window.openProfileView = (subtitle, title, icon, candidateId) => {
    const modal = document.getElementById('modal-profile-view');
    if (!modal) return;

    // Set Header
    const titleEl = document.getElementById('profile-title');
    const subtitleEl = document.getElementById('profile-subtitle');
    if (titleEl) titleEl.innerText = title;
    if (subtitleEl) subtitleEl.innerText = subtitle;

    // Set Icon
    const iconBox = document.getElementById('profile-icon-box');
    if (iconBox) {
        iconBox.innerHTML = `<i class="fas ${icon} text-xl"></i>`;
    }

    // Navigation
    const navContainer = document.getElementById('profile-nav-container');
    if (navContainer) {
        let navHtml = '';
        if (candidateId && currentInboxQueue && currentInboxQueue.length > 1) {
            const idx = currentInboxQueue.findIndex(c => c.id === candidateId);
            if (idx !== -1) {
                const prev = idx > 0 ? currentInboxQueue[idx - 1].id : null;
                const next = idx < currentInboxQueue.length - 1 ? currentInboxQueue[idx + 1].id : null;

                navHtml = `
                    <div class="flex items-center gap-2">
                        <button onclick="showCandidateProfile('${prev}')" ${!prev ? 'disabled' : ''} class="w-10 h-10 flex items-center justify-center bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-50 transition shadow-sm disabled:opacity-30">
                            <i class="fas fa-chevron-left text-xs"></i>
                        </button>
                        <span class="text-[10px] font-bold text-slate-400 font-mono">${idx + 1} / ${currentInboxQueue.length}</span>
                        <button onclick="showCandidateProfile('${next}')" ${!next ? 'disabled' : ''} class="w-10 h-10 flex items-center justify-center bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-50 transition shadow-sm disabled:opacity-30">
                            <i class="fas fa-chevron-right text-xs"></i>
                        </button>
                    </div>
                `;
            }
        }
        navContainer.innerHTML = navHtml;
    }

    modal.classList.remove('hidden');
};

// --- SHAREABLE PROFILE LINK ---
function _shareHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const chr = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + chr;
        hash |= 0;
    }
    return Math.abs(hash).toString(36);
}

window.generateShareLink = async (candidateId) => {
    const secret = 'rshr2026';
    const token = _shareHash(candidateId + ':' + secret);
    const baseUrl = window.location.href.split('/').slice(0, -1).join('/');
    const shareUrl = `${baseUrl}/share.html?id=${candidateId}&token=${token}`;
    try {
        await navigator.clipboard.writeText(shareUrl);
        showToast('Profile link copied to clipboard!');
    } catch (e) {
        // Fallback for older browsers
        const ta = document.createElement('textarea');
        ta.value = shareUrl;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        showToast('Profile link copied to clipboard!');
    }
};

window.showCandidateProfile = (id) => {
    const c = cachedCandidates.find(x => x.id === id);
    if (!c) return;

    window.openProfileView('Candidate Profile', c.name, 'fa-user-tie', c.id);

    // Identity Update
    document.getElementById('profile-name').innerText = c.name;
    document.getElementById('profile-type').innerText = c.currentCompany || 'Independent Professional';
    const candidateContactInput = document.getElementById('candidate-is-contact');
    if (candidateContactInput) {
        candidateContactInput.value = c.isContact ? 'true' : 'false';
    }
    const avatarBox = document.getElementById('profile-avatar-box');
    if (avatarBox) {
        avatarBox.innerHTML = c.name.split(' ').map(n => n[0]).join('').toUpperCase();
        avatarBox.classList.add('bg-blue-600', 'text-white', 'font-black');
    }

    // Status Badge
    const badgeContainer = document.getElementById('profile-status-badge');
    if (badgeContainer) {
        const stageClass = c.stage === 'REJECTED' ? 'badge-red' : (c.stage === 'HIRED' ? 'badge-green' : 'badge-blue');
        badgeContainer.innerHTML = `<span class="badge ${stageClass} scale-110 px-4 py-1.5 shadow-sm">${c.stage || 'Sourced'}</span>`;
    }

    // Header Metrics
    const headerMetrics = document.getElementById('profile-header-metrics');
    if (headerMetrics) {
        const score = c.score || (c.technicalRating && c.communicationRating ? Math.round((Number(c.technicalRating || 0) + Number(c.communicationRating || 0)) / 2) : 'N/A');
        headerMetrics.innerHTML = `
            <span class="rounded-lg bg-white/90 dark:bg-slate-800/90 px-3 py-1 text-[10px] font-bold text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700">Experience: ${c.experience || 0} yrs</span>
            <span class="rounded-lg bg-white/90 dark:bg-slate-800/90 px-3 py-1 text-[10px] font-bold text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700">Notice: ${c.noticePeriod || 0} days</span>
            <span class="rounded-lg bg-white/90 dark:bg-slate-800/90 px-3 py-1 text-[10px] font-bold text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700">Expected: ₹${(c.expectedCTC || 0).toLocaleString()}/mo</span>
            <span class="rounded-lg bg-white/90 dark:bg-slate-800/90 px-3 py-1 text-[10px] font-bold text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700">Score: ${score}</span>
        `;
    }

    // Sidebar Actions
    const sidebarActions = document.getElementById('profile-sidebar-actions');
    if (sidebarActions) {
        sidebarActions.innerHTML = `
            <button onclick="toggleContactStatus('${c.id}')" class="w-full py-3 ${c.isContact ? 'bg-slate-200 text-slate-800' : 'bg-blue-100 text-blue-700'} rounded-xl font-bold flex items-center justify-center gap-2 transition-all">
                <i class="fas ${c.isContact ? 'fa-user-minus' : 'fa-user-plus'}"></i> ${c.isContact ? 'Remove Contact' : 'Save to Contacts'}
            </button>
            <button onclick="initiateRemoteCall('${c.phone}', '${c.name.replace(/'/g, "\\'")}')" class="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold flex items-center justify-center gap-2 transition-all shadow-lg shadow-emerald-500/20">
                <i class="fas fa-phone"></i> Call Now
            </button>
            <button onclick="window.open('https://wa.me/91${c.phone}', '_blank')" class="w-full py-3 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-xl font-bold flex items-center justify-center gap-2 transition-all">
                <i class="fab fa-whatsapp text-emerald-500"></i> WhatsApp
            </button>
            <button onclick="window.open('mailto:${c.email}', '_blank')" class="w-full py-3 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-xl font-bold flex items-center justify-center gap-2 transition-all">
                <i class="fas fa-envelope text-blue-500"></i> Send Email
            </button>
        `;
    }

    // Main Content
    const content = document.getElementById('profile-view-content');
    if (content) {
        content.innerHTML = `
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                <!-- Resume Card -->
                ${c.resumeUrl ? `
                <div class="col-span-full form-group-card border-dashed border-blue-200 bg-blue-50/20">
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-4">
                            <div class="w-12 h-12 rounded-xl bg-blue-600 flex items-center justify-center text-white">
                                <i class="fas fa-file-pdf text-xl"></i>
                            </div>
                            <div>
                                <p class="text-sm font-bold text-slate-800 dark:text-slate-200">Curriculum Vitae</p>
                                <p class="text-xs text-slate-500">Applicant Resume is encrypted and stored</p>
                            </div>
                        </div>
                        <button onclick="previewResume('${c.resumeUrl}')" class="px-6 py-2 bg-blue-600 text-white rounded-xl text-xs font-bold shadow-lg shadow-blue-500/30 hover:scale-105 transition-transform">Preview Resume</button>
                    </div>
                </div>` : ''}

                <!-- Stats Cards -->
                <div class="form-group-card">
                    <h5 class="field-label">Professional Experience</h5>
                    <div class="space-y-4">
                        <div>
                            <p class="text-[10px] text-slate-400 uppercase font-black">Experience Level</p>
                            <p class="text-lg font-black text-slate-800 dark:text-white">${c.experience || 0} Years</p>
                        </div>
                        <div>
                            <p class="text-[10px] text-slate-400 uppercase font-black">Highest Qualification</p>
                            <p class="text-lg font-black text-slate-800 dark:text-white">${c.qualification || 'N/A'}</p>
                        </div>
                    </div>
                </div>

                <div class="form-group-card">
                    <h5 class="field-label">Compensation & Notice</h5>
                    <div class="space-y-4">
                        <div class="flex justify-between">
                            <div>
                                <p class="text-[10px] text-slate-400 uppercase font-black">Expected CTC</p>
                                <p class="text-lg font-black text-blue-600">₹${(c.expectedCTC || 0).toLocaleString()}/mo</p>
                            </div>
                            <div>
                                <p class="text-[10px] text-slate-400 uppercase font-black">Current</p>
                                <p class="text-lg font-black text-slate-400">₹${(c.currentCTC || 0).toLocaleString()}/mo</p>
                            </div>
                        </div>
                        <div>
                            <p class="text-[10px] text-slate-400 uppercase font-black">Availability</p>
                            <p class="text-lg font-black text-amber-600">${c.noticePeriod || 0} Days Notice</p>
                        </div>
                    </div>
                </div>

                 <!-- Ratings Card -->
                <div class="col-span-full form-group-card">
                    <h5 class="field-label">Internal Evaluations</h5>
                    <div class="grid grid-cols-2 gap-8">
                        <div>
                             <p class="text-[10px] text-slate-400 uppercase font-black mb-1">Technical Ability</p>
                             <div class="flex gap-1 text-amber-400">
                                ${Array(5).fill(0).map((_, i) => `<i class="fas fa-star ${i < (c.technicalRating || 0) ? 'text-amber-400' : 'text-slate-200 dark:text-slate-700'}"></i>`).join('')}
                             </div>
                        </div>
                        <div>
                             <p class="text-[10px] text-slate-400 uppercase font-black mb-1">Communication</p>
                             <div class="flex gap-1 text-blue-400">
                                ${Array(5).fill(0).map((_, i) => `<i class="fas fa-star ${i < (c.communicationRating || 0) ? 'text-blue-400' : 'text-slate-200 dark:text-slate-700'}"></i>`).join('')}
                             </div>
                        </div>
                    </div>
                </div>

                <!-- Bio/Notes -->
                <div class="col-span-full form-group-card">
                    <h5 class="field-label">Screener Notes</h5>
                    <p class="text-sm text-slate-600 dark:text-slate-400 whitespace-pre-wrap leading-relaxed">${c.screenerNotes || 'No internal notes available for this candidate.'}</p>
                </div>
            </div>
        `;
    }

    // Right Sidebar: Actions
    const actionsArea = document.getElementById('profile-view-actions');
    if (actionsArea) {
        actionsArea.innerHTML = `
            <div class="space-y-4">
                <p class="text-[10px] font-black uppercase text-slate-400 tracking-widest">Workflow Actions</p>
                <button onclick="updateCandidateStage('${c.id}', 'Interview')" class="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-black text-xs">Mark Interview</button>
                <button onclick="updateCandidateStage('${c.id}', 'Selected')" class="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-black text-xs">Mark Selected</button>
                <button onclick="updateCandidateStage('${c.id}', 'Rejected')" class="w-full py-3 bg-red-600 hover:bg-red-700 text-white rounded-xl font-black text-xs">Mark Rejected</button>

                <div class="pt-4 border-t border-slate-100 dark:border-slate-800">
                    <p class="text-[10px] font-black uppercase text-slate-400 tracking-widest mb-2">Screener Notes</p>
                    <textarea id="profile-quick-note" rows="4" class="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs" placeholder="Write a quick note..."></textarea>
                    <button onclick="saveCandidateNote('${c.id}')" class="mt-2 w-full py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-semibold text-xs">Save Note</button>
                </div>

                <div class="pt-4 border-t border-slate-100 dark:border-slate-800">
                    <p class="text-[10px] font-black uppercase text-slate-400 tracking-widest mb-3">External Tools</p>
                    <button onclick="openInterviewModal()" class="w-full py-3 bg-purple-600 hover:bg-purple-700 text-white rounded-xl font-bold text-xs">Schedule Interview</button>
                    <button onclick="openOfferModal('${c.id}')" class="mt-2 w-full py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold text-xs">Send Offer</button>
                    <button onclick="generateShareLink('${c.id}')" class="mt-2 w-full py-3 bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-xl font-bold text-xs">Share Profile</button>
                </div>
            </div>
        `;
    }
};

window.saveCandidateNote = async (candidateId) => {
    const noteInput = document.getElementById('profile-quick-note');
    if (!noteInput) return;
    const note = noteInput.value.trim();
    if (!note) return showToast('Please type a note before saving.', 'error');

    const candidate = cachedCandidates.find(c => c.id === candidateId);
    if (!candidate) return showToast('Candidate not found', 'error');

    try {
        const existing = candidate.screenerNotes || '';
        const updatedNotes = existing ? `${existing}\n\n${new Date().toLocaleString()}: ${note}` : `${new Date().toLocaleString()}: ${note}`;

        await updateDoc(doc(db, 'candidates', candidateId), { screenerNotes: updatedNotes });
        candidate.screenerNotes = updatedNotes;
        noteInput.value = '';
        showToast('Note saved successfully');
        showCandidateProfile(candidateId);
    } catch (e) {
        console.error('Unable to save candidate note', e);
        showToast('Failed to save note', 'error');
    }
};

window.initiateRemoteCall = async (phoneNumber, candidateName) => {
    if (!currentUser) {
        if (typeof showToast === 'function') showToast("Please log in first", "error");
        else alert("Please log in first");
        return;
    }

    try {
        const callRef = doc(db, "remote_calls", currentUser.uid);
        await setDoc(callRef, {
            phoneNumber: phoneNumber,
            candidateName: candidateName,
            status: 'pending',
            timestamp: serverTimestamp(),
            uid: currentUser.uid,
            email: currentUser.email
        });
        if (typeof showToast === 'function') showToast(`Calling ${candidateName}... Check your phone.`, "success");
        else alert(`Calling ${candidateName}... Check your phone.`);
    } catch (error) {
        console.error("Error initiating remote call:", error);
        if (typeof showToast === 'function') showToast("Failed to initiate call", "error");
        else alert("Failed to initiate call");
    }
};

window.showJobDetails = (id) => {
    const j = cachedJobs.find(x => x.id === id);
    if (!j) return;
    const comp = cachedCompanies.find(c => c.id === j.companyId);

    window.openProfileView('Job Opening', j.title, 'fa-briefcase');
    const grid = document.getElementById('profile-detailed-grid');
    const badgeContainer = document.getElementById('profile-status-badge');

    if (badgeContainer) {
        const priorityClass = j.priority === 'Urgent' ? 'badge-red' : (j.priority === 'Medium' ? 'badge-orange' : 'badge-blue');
        badgeContainer.innerHTML = `<span class="badge ${priorityClass} scale-110 px-4 py-1.5 shadow-sm">${j.priority} Priority</span>`;
    }

    grid.innerHTML = `
                <div class="profile-data-card">
                    <p class="profile-label">Hiring Metadata</p>
                    <div class="grid grid-cols-2 gap-4 mt-2">
                        <div>
                            <p class="text-[10px] text-slate-400 uppercase">Company</p>
                            <p class="profile-value">${comp ? comp.name : 'N/A'}</p>
                        </div>
                        <div>
                            <p class="text-[10px] text-slate-400 uppercase">Department</p>
                            <p class="profile-value">${j.department}</p>
                        </div>
                        <div>
                            <p class="text-[10px] text-slate-400 uppercase">Location</p>
                            <p class="profile-value">${j.location}</p>
                        </div>
                        <div>
                            <p class="text-[10px] text-slate-400 uppercase">Designation</p>
                            <p class="profile-value">${j.designation || j.title}</p>
                        </div>
                    </div>
                </div>
                <div class="profile-data-card">
                    <p class="profile-label">Budget & Timeline</p>
                    <div class="grid grid-cols-1 gap-4 mt-2">
                        <div class="flex items-center justify-between">
                            <span class="text-xs text-slate-500">Annual Budget</span>
                            <span class="profile-value text-emerald-600">₹${(j.budget || 0).toLocaleString()}</span>
                        </div>
                        <div class="flex items-center justify-between">
                            <span class="text-xs text-slate-500">Closing Date</span>
                            <span class="profile-value text-red-500">${j.closingDate ? new Date(j.closingDate).toLocaleDateString() : 'N/A'}</span>
                        </div>
                         <div class="flex items-center justify-between">
                            <span class="text-xs text-slate-500">MRF Received</span>
                            <span class="profile-value">${j.mrfReceived === 'Yes' ? '✅ Verified' : '⏳ Pending'}</span>
                        </div>
                    </div>
                </div>
                <div class="profile-data-card md:col-span-2">
                    <p class="profile-label">Job Description</p>
                    <div class="mt-3 text-sm text-slate-600 dark:text-slate-300 leading-relaxed whitespace-pre-wrap">${j.description || 'No description provided.'}</div>
                </div>
            `;
};

window.showCompanyProfile = (id) => {
    const c = cachedCompanies.find(x => x.id === id);
    if (!c) return;

    window.openProfileView('Company Profile', c.name, 'fa-building');
    const grid = document.getElementById('profile-detailed-grid');

    grid.innerHTML = `
                <div class="profile-data-card">
                    <p class="profile-label">Entity Details</p>
                    <div class="space-y-3 mt-2">
                        <div class="flex items-center gap-3 text-sm">
                            <i class="fas fa-tag text-blue-500 w-4"></i>
                            <span class="text-slate-700 dark:text-slate-300 font-bold">${c.industry || 'General Industry'}</span>
                        </div>
                        <div class="flex items-center gap-3 text-sm">
                            <i class="fas fa-globe text-emerald-500 w-4"></i>
                            <a href="${c.website}" target="_blank" class="text-blue-500 hover:underline">${c.website || 'N/A'}</a>
                        </div>
                        <div class="flex items-center gap-3 text-sm">
                            <i class="fas fa-map-pin text-red-400 w-4"></i>
                            <span class="text-slate-700 dark:text-slate-300">${c.location || 'N/A'}</span>
                        </div>
                    </div>
                </div>
                <div class="profile-data-card">
                    <p class="profile-label">Headquarters Address</p>
                    <div class="mt-2 text-sm text-slate-600 dark:text-slate-300 italic leading-snug">
                        ${c.address || 'Address details not specified.'}
                    </div>
                </div>
                <div class="profile-data-card md:col-span-2">
                    <p class="profile-label">About the Company</p>
                    <div class="mt-3 text-sm text-slate-600 dark:text-slate-300 leading-relaxed whitespace-pre-wrap">${c.about || 'No description provided.'}</div>
                </div>
                <div class="profile-data-card md:col-span-2 bg-slate-100/50 dark:bg-slate-800/50">
                    <p class="profile-label">Active Openings</p>
                    <div class="flex flex-wrap gap-2 mt-3">
                         ${cachedJobs.filter(j => j.companyId === id).length > 0
            ? cachedJobs.filter(j => j.companyId === id).map(j => `<span class="px-3 py-1 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg text-xs font-semibold">${j.title}</span>`).join('')
            : '<p class="text-xs text-slate-400 italic">No active job openings for this entity.</p>'}
                    </div>
                </div>
            `;
};


window.currentInboxJobId = null;
let currentInboxFilter = 'all';

window.renderTalentPool = () => {
    const overviewLevel = document.getElementById('talentpool-overview-level');
    const inboxLevel = document.getElementById('talentpool-inbox-level');
    const jobList = document.getElementById('talentpool-job-list');
    if (!jobList) return;

    if (window.currentInboxJobId) {
        // ENFORCE INBOX VIEW
        overviewLevel.classList.add('hidden');
        inboxLevel.classList.remove('hidden');

        const job = cachedJobs.find(j => j.id === window.currentInboxJobId);
        if (job) {
            const titleEl = document.getElementById('section-title');
            const subtitleEl = document.getElementById('section-subtitle');
            if (titleEl) titleEl.innerText = job.title;
            if (subtitleEl) subtitleEl.innerHTML = `<i class="fas fa-map-marker-alt mr-1"></i> ${job.location} • <span class="badge badge-blue !py-0 !px-2 text-[9px] ml-1">${job.status || 'Active'}</span>`;
        }

        // Hide FAB in inbox
        const fab = document.getElementById('fab-container');
        if (fab) fab.classList.add('hidden');

        // Render the candidates for this job
        if (typeof renderInboxCandidates === 'function') renderInboxCandidates();

        // Always render the job list in the background so it's ready for toggle back
    } else {
        // ENFORCE OVERVIEW VIEW
        overviewLevel.classList.remove('hidden');
        inboxLevel.classList.add('hidden');

        // Show FAB in overview
        const fab = document.getElementById('fab-container');
        if (fab) fab.classList.remove('hidden');
    }

    const searchTerm = getEffectiveQuery('talentpool');
    const statusFilter = document.getElementById('talentpool-filter-status')?.value || 'all';

    const candidates = cachedTalentPool;

    // Filter jobs by search and status
    let jobs = cachedJobs;
    if (statusFilter !== 'all') {
        jobs = jobs.filter(j => j.status === statusFilter);
    } else {
        // Default 'all' often means Active/Open in context of management
        // But let's show everything if specifically requested 'all'
    }

    if (searchTerm) {
        jobs = jobs.filter(j => j.title.toLowerCase().includes(searchTerm) || j.department.toLowerCase().includes(searchTerm));
    }

    if (jobs.length === 0) {
        jobList.innerHTML = `
                    <div class="py-20 text-center bg-white dark:bg-slate-800/50 rounded-3xl border border-dashed border-slate-200 dark:border-slate-700">
                        <div class="w-16 h-16 bg-slate-50 dark:bg-slate-800 rounded-full flex items-center justify-center mx-auto mb-4 text-slate-300">
                            <i class="fas fa-search text-2xl"></i>
                        </div>
                        <p class="text-slate-400 font-medium">No matching job openings found.</p>
                    </div>`;
        return;
    }

    jobList.innerHTML = jobs.map(j => {
        const jobResponses = candidates.filter(c => c.jobId === j.id);
        const newCount = jobResponses.filter(c => c.isNew).length;
        const rejectedStages = ['REJECTED', 'Rejected', 'Backed Out', 'Not Interested'];
        const shortlistedCount = cachedCandidates.filter(c => c.jobId === j.id && !c.inTalentPool && !rejectedStages.includes(c.stage)).length;
        const rejectedCount = cachedCandidates.filter(c => c.jobId === j.id && rejectedStages.includes(c.stage)).length;
        const statusColor = j.status === 'Open' || j.status === 'Active' ? 'emerald' : 'slate';

        return `
                    <div onclick="viewJobInbox('${j.id}')" class="group bg-white dark:bg-slate-800 p-4 sm:p-5 rounded-2xl border border-slate-200 dark:border-slate-700 hover:border-blue-300 dark:hover:border-blue-600 hover:shadow-xl hover:shadow-blue-500/5 transition-all cursor-pointer flex flex-col sm:flex-row items-start sm:items-center gap-4">
                        <!-- Left: Icon & Title -->
                        <div class="flex items-center gap-4 flex-1 min-w-0">
                            <div class="w-12 h-12 flex-shrink-0 bg-blue-50 dark:bg-blue-900/20 rounded-xl flex items-center justify-center text-blue-600 group-hover:bg-blue-600 group-hover:text-white transition-all">
                                <i class="fas fa-briefcase text-xl"></i>
                            </div>
                            <div class="min-w-0">
                                <h4 class="font-bold text-slate-800 dark:text-white truncate group-hover:text-blue-600 transition-colors">${j.title}</h4>
                                <div class="flex items-center gap-3 mt-1 text-[11px] text-slate-500 font-medium">
                                    <span class="flex items-center gap-1"><i class="fas fa-map-marker-alt opacity-70"></i> ${j.location}</span>
                                    <span class="opacity-30">•</span>
                                    <span class="flex items-center gap-1"><i class="fas fa-building opacity-70"></i> ${j.department}</span>
                                    <span class="opacity-30">•</span>
                                    <span class="flex items-center gap-1 bg-${statusColor}-50 text-${statusColor}-600 px-1.5 py-0.5 rounded text-[9px] uppercase font-bold">${j.status || 'Active'}</span>
                                </div>
                            </div>
                        </div>

                        <!-- Right: Stats & Actions -->
                        <div class="flex items-center justify-between sm:justify-end gap-6 w-full sm:w-auto pt-3 sm:pt-0 border-t sm:border-t-0 border-slate-100 dark:border-slate-800">
                            <div class="flex gap-6 text-center">
                                <div>
                                    <p class="text-[9px] uppercase font-bold text-slate-400 tracking-wider mb-0.5">Total</p>
                                    <p class="text-sm font-bold text-slate-700 dark:text-slate-300">${jobResponses.length}</p>
                                </div>
                                <div class="relative">
                                    <p class="text-[9px] uppercase font-bold text-slate-400 tracking-wider mb-0.5">Shortlisted</p>
                                    <p class="text-sm font-bold text-emerald-600">${shortlistedCount}</p>
                                </div>
                                <div>
                                    <p class="text-[9px] uppercase font-bold text-slate-400 tracking-wider mb-0.5">Rejected</p>
                                    <p class="text-sm font-bold text-red-500">${rejectedCount}</p>
                                </div>
                                <div>
                                    <p class="text-[9px] uppercase font-bold text-slate-400 tracking-wider mb-0.5">New</p>
                                    <p class="text-sm font-bold ${newCount > 0 ? 'text-blue-600' : 'text-slate-400'}">${newCount}</p>
                                </div>
                            </div>
                            
                            <div class="flex items-center gap-3 ml-2">
                                <div class="w-8 h-8 rounded-full border border-slate-100 dark:border-slate-700 flex items-center justify-center text-slate-400 group-hover:text-blue-600 group-hover:border-blue-100 transition-all">
                                    <i class="fas fa-chevron-right text-xs"></i>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
    }).join('');
};

window.viewJobInbox = async (jobId) => {
    window.currentInboxJobId = jobId;
    currentInboxFilter = 'all';

    // Switch to talentpool section
    // renderTalentPool will handle the level toggling and title updates
    await showSection('talentpool');
};

window.exitJobInbox = async () => {
    window.currentInboxJobId = null;
    await showSection('talentpool');
};

window.filterInbox = (type) => {
    currentInboxFilter = type;

    // Update UI state for folders
    ['all', 'new', 'shortlisted', 'rejected'].forEach(f => {
        const el = document.getElementById(`folder-${f}`);
        if (f === type) {
            el.classList.add('bg-blue-50', 'text-blue-700', 'border-blue-100');
            el.classList.remove('hover:bg-slate-50', 'dark:hover:bg-slate-800', 'text-slate-600', 'dark:text-slate-400');
        } else {
            el.classList.remove('bg-blue-50', 'text-blue-700', 'border-blue-100');
            el.classList.add('hover:bg-slate-50', 'dark:hover:bg-slate-800', 'text-slate-600', 'dark:text-slate-400');
        }
    });

    renderInboxCandidates();
};

let currentInboxQueue = [];

window.renderInboxCandidates = () => {
    const searchTerm = getEffectiveQuery('inbox');
    const listContainer = document.getElementById('inbox-candidate-list');
    if (!listContainer || !window.currentInboxJobId) return;

    const job = cachedJobs.find(j => j.id === window.currentInboxJobId);
    let candidates = cachedTalentPool.filter(c => c.jobId === window.currentInboxJobId);
    const rejectedStages = ['REJECTED', 'Rejected', 'Backed Out', 'Not Interested'];
    const shortlistedCandidates = cachedCandidates.filter(c => c.jobId === window.currentInboxJobId && !rejectedStages.includes(c.stage));
    const rejectedCandidates = cachedCandidates.filter(c => c.jobId === window.currentInboxJobId && rejectedStages.includes(c.stage));

    // Apply Folder Filter
    if (currentInboxFilter === 'all') candidates = candidates; // now just refers to talentpool candidates
    else if (currentInboxFilter === 'new') candidates = candidates.filter(c => c.isNew);
    else if (currentInboxFilter === 'shortlisted') candidates = shortlistedCandidates;
    else if (currentInboxFilter === 'rejected') candidates = rejectedCandidates;

    // Apply Search Filter
    if (searchTerm) {
        candidates = candidates.filter(c =>
            (c.name || "").toLowerCase().includes(searchTerm) ||
            (c.email || "").toLowerCase().includes(searchTerm) ||
            ((c.skills || "") && c.skills.toLowerCase().includes(searchTerm)) ||
            ((c.currentDesignation || "") && c.currentDesignation.toLowerCase().includes(searchTerm))
        );
    }

    currentInboxQueue = candidates; // Store for navigation

    // Update Counts
    document.getElementById('count-all').innerText = cachedTalentPool.filter(c => c.jobId === window.currentInboxJobId).length;
    document.getElementById('count-new').innerText = cachedTalentPool.filter(c => c.jobId === window.currentInboxJobId && c.isNew).length;
    document.getElementById('count-shortlisted').innerText = shortlistedCandidates.length;
    document.getElementById('count-rejected').innerText = rejectedCandidates.length;

    if (candidates.length === 0) {
        listContainer.innerHTML = `
                    <div class="py-20 text-center">
                        <div class="w-16 h-16 bg-slate-50 dark:bg-slate-900 rounded-full flex items-center justify-center mx-auto mb-4 text-slate-300">
                            <i class="fas fa-search text-2xl"></i>
                        </div>
                        <p class="text-slate-400 font-medium">No candidates found matching your criteria.</p>
                    </div>`;
        return;
    }

    listContainer.innerHTML = candidates.map((c, index) => {
        const score = calculateMatchScore(c, job);
        const skillsArr = (c.skills || '').split(',').map(s => s.trim()).filter(s => s !== '');
        const staggerClass = index < 10 ? `animate-fade-up stagger-${(index % 5) + 1}` : '';

        return `
                    <div class="group bg-white dark:bg-slate-800/50 p-5 rounded-2xl border border-slate-100 dark:border-slate-800 hover:border-blue-200 dark:hover:border-blue-900 transition-all flex flex-col md:flex-row gap-5 relative hover-lift ${staggerClass}">
                        <div class="absolute top-4 left-3">
                            <label for="cand-check-${c.id}" class="sr-only">Select ${c.name}</label>
                            <input type="checkbox" id="cand-check-${c.id}" name="inbox-candidate-check" value="${c.id}" class="w-4 h-4 rounded border-slate-300 text-blue-600 transition-all cursor-pointer">
                        </div>
                        
                        <!-- Main Content -->
                        <div class="flex-1 ml-6">
                            <div class="flex justify-between items-start mb-3">
                                <div>
                                    <h4 class="font-bold text-slate-800 dark:text-white flex items-center gap-2">
                                        ${c.name}
                                        ${c.isNew ? '<span class="bg-blue-600 text-white text-[8px] font-bold px-1.5 py-0.5 rounded">NEW</span>' : ''}
                                    </h4>
                                    <p class="text-xs text-slate-500 font-medium mt-0.5">${c.currentDesignation || 'Candidate'} @ ${c.currentCompany || 'N/A'}</p>
                                </div>
                                <div class="text-right">
                                    <div class="text-[10px] font-bold text-blue-500 uppercase tracking-widest mb-1">Match Score</div>
                                    <div class="flex items-center gap-2">
                                        <div class="w-24 h-1.5 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                                            <div class="h-full bg-blue-500" style="width: ${score}%"></div>
                                        </div>
                                        <span class="text-xs font-bold text-slate-700 dark:text-slate-300">${score}%</span>
                                    </div>
                                </div>
                            </div>
                            
                            <!-- Skills Display -->
                            ${skillsArr.length > 0 ? `
                            <div class="flex flex-wrap gap-1.5 mb-4">
                                ${skillsArr.slice(0, 6).map(s => `<span class="px-2 py-0.5 bg-slate-100/50 dark:bg-slate-800 text-slate-500 dark:text-slate-400 rounded text-[10px] border border-slate-200/50 dark:border-slate-700/50 font-medium hover:bg-slate-200 dark:hover:bg-slate-700 transition">${s}</span>`).join('')}
                                ${skillsArr.length > 6 ? `<span class="text-[10px] text-slate-400 font-medium ml-1">+${skillsArr.length - 6} more</span>` : ''}
                            </div>
                            ` : ''}
                            
                            <div class="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-2 pt-4 border-t border-slate-50 dark:border-slate-800/50 text-[11px]">
                                <div>
                                    <p class="text-slate-400 uppercase font-bold tracking-tighter mb-0.5">Experience</p>
                                    <p class="text-slate-700 dark:text-slate-300 font-semibold italic">${c.experience || '0'} Years</p>
                                </div>
                                <div>
                                    <p class="text-slate-400 uppercase font-bold tracking-tighter mb-0.5">Current/Exp CTC</p>
                                    <p class="text-slate-700 dark:text-slate-300 font-semibold italic">₹${(c.currentCTC || 0).toLocaleString()} / ₹${(c.expectedCTC || 0).toLocaleString()}</p>
                                </div>
                                <div>
                                    <p class="text-slate-400 uppercase font-bold tracking-tighter mb-0.5">Notice Period</p>
                                    <p class="text-slate-700 dark:text-slate-300 font-semibold italic">${c.noticePeriod || 'N/A'}</p>
                                </div>
                                <div>
                                    <p class="text-slate-400 uppercase font-bold tracking-tighter mb-0.5">Location</p>
                                    <p class="text-slate-700 dark:text-slate-300 font-semibold italic">${c.city || 'N/A'}</p>
                                </div>
                            </div>
                        </div>
                        
                        <!-- Actions -->
                        <div class="flex flex-row md:flex-col gap-2 justify-center border-l md:border-l border-slate-50 dark:border-slate-800 pl-0 md:pl-5">
                            <button onclick="showCandidateProfile('${c.id}')" class="flex-1 md:flex-none px-4 py-2 bg-slate-50 dark:bg-slate-900/50 text-slate-600 dark:text-slate-400 rounded-xl text-xs font-bold hover:bg-slate-100 transition hover-lift">View</button>
                            <button onclick="moveToPipeline('${c.id}')" class="flex-1 md:flex-none px-4 py-2 bg-blue-600 text-white rounded-xl text-xs font-bold hover:bg-blue-700 transition shadow-lg shadow-blue-500/20 hover-lift">Shortlist</button>
                        </div>
                    </div>
                `;
    }).join('');
};

window.moveToPipeline = async (candId) => {
    const c = cachedCandidates.find(x => x.id === candId);
    if (!c) return;

    try {
        const docRef = doc(db, 'candidates', candId);
        await updateDoc(docRef, {
            inTalentPool: false,
            isNew: false,
            stage: 'Screening',
            updatedAt: serverTimestamp()
        });
        showToast(`Candidate ${c.name} moved to Screening pipeline.`);
    } catch (error) {
        console.error("Error moving to pipeline:", error);
        showToast("Failed to move candidate.", "error");
    }
};

window.bulkInboxAction = async (action) => {
    const selected = Array.from(document.querySelectorAll('input[name="inbox-candidate-check"]:checked')).map(i => i.value);
    if (selected.length === 0) return;

    const isShortlist = action === 'shortlist';

    try {
        showToast(`Processing ${selected.length} candidates...`);

        const promises = selected.map(async (id) => {
            const c = cachedCandidates.find(x => x.id === id);
            if (!c) return Promise.resolve();

            return updateDoc(doc(db, 'candidates', id), {
                inTalentPool: false,
                isNew: false,
                stage: isShortlist ? 'Screening' : 'REJECTED',
                updatedAt: serverTimestamp()
            });
        });

        await Promise.all(promises);
        showToast(`Bulk ${isShortlist ? 'shortlisted' : 'rejected'} ${selected.length} candidates.`);
        toggleBulkBar();
    } catch (err) {
        console.error("Bulk action error:", err);
        showToast("Failed some bulk actions.", "error");
    }
};

// Bulk Selection Toggle
document.addEventListener('change', (e) => {
    if (e.target.id === 'inbox-select-all') {
        const checks = document.querySelectorAll('input[name="inbox-candidate-check"]');
        checks.forEach(c => c.checked = e.target.checked);
        toggleBulkBar();
    }
    if (e.target.name === 'inbox-candidate-check') {
        toggleBulkBar();
    }
    if (e.target.name === 'offer-check') {
        toggleOfferBulkBar();
    }
});

window.toggleOfferBulkBar = () => {
    const selected = document.querySelectorAll('input[name="offer-check"]:checked').length;
    const bar = document.getElementById('offer-bulk-bar');
    const countEl = document.getElementById('offer-selected-count');
    if (bar) {
        if (selected > 0) {
            bar.classList.remove('translate-y-32', 'opacity-0', 'pointer-events-none');
            bar.classList.add('translate-y-0', 'opacity-100');
            if (countEl) countEl.innerText = selected;
        } else {
            bar.classList.add('translate-y-32', 'opacity-0', 'pointer-events-none');
            bar.classList.remove('translate-y-0', 'opacity-100');
        }
    }
};

window.clearOfferSelection = () => {
    document.querySelectorAll('input[name="offer-check"]').forEach(c => c.checked = false);
    toggleOfferBulkBar();
};

window.bulkOfferAction = async (status) => {
    const selected = Array.from(document.querySelectorAll('input[name="offer-check"]:checked')).map(i => i.value);
    if (selected.length === 0) return;

    try {
        showToast(`Processing ${selected.length} offers...`);
        const promises = selected.map(id => updateOfferStatus(id, status));
        await Promise.all(promises);
        showToast(`Bulk updated to ${status}.`);
        clearOfferSelection();
    } catch (err) {
        console.error("Bulk offer update error:", err);
        showToast("Bulk action failed.", "error");
    }
};

function toggleBulkBar() {
    const selected = document.querySelectorAll('input[name="inbox-candidate-check"]:checked').length;
    const bar = document.getElementById('bulk-actions');
    if (bar) {
        if (selected > 0) {
            bar.classList.remove('hidden');
            bar.classList.add('flex');
        } else {
            bar.classList.add('hidden');
            bar.classList.remove('flex');
        }
    }
}


window.addCandidateTag = async (id, tag) => {
    if (!tag.trim()) return;
    try {
        const c = cachedCandidates.find(x => x.id === id);
        const tags = [...(c.tags || [])];
        if (!tags.includes(tag.trim())) {
            tags.push(tag.trim());
            await updateDoc(doc(db, "candidates", id), { tags });
            c.tags = tags; renderTalentPool();
        }
    } catch (e) { showError("Failed"); }
};

window.updateTalentPoolBadge = () => {
    if (!cachedTalentPool) return;
    const newCount = cachedTalentPool.filter(c => c.isNew).length;
    const badge = document.getElementById('talent-pool-badge');
    if (badge) {
        if (newCount > 0) {
            badge.innerText = newCount;
            badge.classList.remove('hidden');
            badge.classList.add('flex');
        } else {
            badge.classList.add('hidden');
            badge.classList.remove('flex');
        }
    }
};
// Task Board logic removed per user request



function calculateMatchScore(candidate, job) {
    // Simulated AI match logic
    if (!job) return 70;
    let base = 65;
    if (candidate.experience && parseInt(candidate.experience) >= 2) base += 10;
    if (candidate.city && job.location && candidate.city.toLowerCase() === job.location.toLowerCase()) base += 15;
    if (candidate.isNew) base += 5;
    return Math.min(98, base);
}

// ===================== FLOATING CALCULATOR LOGIC =====================
let calcDisplayValue = '0';
let calcFirstOperand = null;
let calcOperator = null;
let calcWaitingForSecondOperand = false;

window.toggleCalculator = () => {
    const calc = document.getElementById('floating-calculator');
    const toggleBtn = document.getElementById('calc-toggle-btn');
    if (!calc) return;

    calc.classList.toggle('hidden');
    if (!calc.classList.contains('hidden')) {
        calc.classList.add('animate-in', 'fade-in', 'zoom-in-95', 'duration-200');
    }
};

window.minimizeCalculator = () => {
    const body = document.getElementById('calc-body');
    if (body) {
        body.classList.toggle('hidden');
    }
};

window.calcNum = (num) => {
    const display = document.getElementById('calc-display');
    if (calcWaitingForSecondOperand) {
        calcDisplayValue = num;
        calcWaitingForSecondOperand = false;
    } else {
        calcDisplayValue = calcDisplayValue === '0' ? num : calcDisplayValue + num;
    }
    if (display) display.value = calcDisplayValue;
};

window.calcOp = (nextOperator) => {
    const inputValue = parseFloat(calcDisplayValue);

    if (calcOperator && calcWaitingForSecondOperand) {
        calcOperator = nextOperator;
        return;
    }

    if (calcFirstOperand === null && !isNaN(inputValue)) {
        calcFirstOperand = inputValue;
    } else if (calcOperator) {
        const result = performCalculation[calcOperator](calcFirstOperand, inputValue);
        calcDisplayValue = `${parseFloat(result.toFixed(7))}`;
        calcFirstOperand = result;
        const display = document.getElementById('calc-display');
        if (display) display.value = calcDisplayValue;
    }

    calcWaitingForSecondOperand = true;
    calcOperator = nextOperator;
};

const performCalculation = {
    '/': (firstOperand, secondOperand) => firstOperand / secondOperand,
    '*': (firstOperand, secondOperand) => firstOperand * secondOperand,
    '+': (firstOperand, secondOperand) => firstOperand + secondOperand,
    '-': (firstOperand, secondOperand) => firstOperand - secondOperand,
    '=': (firstOperand, secondOperand) => secondOperand
};

window.calcClear = () => {
    calcDisplayValue = '0';
    calcFirstOperand = null;
    calcOperator = null;
    calcWaitingForSecondOperand = false;
    const display = document.getElementById('calc-display');
    if (display) display.value = '0';
};

window.calcEqual = () => {
    const inputValue = parseFloat(calcDisplayValue);

    if (calcOperator && !calcWaitingForSecondOperand) {
        const result = performCalculation[calcOperator](calcFirstOperand, inputValue);
        calcDisplayValue = `${parseFloat(result.toFixed(7))}`;
        calcFirstOperand = null;
        calcOperator = null;
        calcWaitingForSecondOperand = false;
        const display = document.getElementById('calc-display');
        if (display) display.value = calcDisplayValue;
    }
};

// --- DRAGGABLE LOGIC ---
(function initCalculatorDraggable() {
    const calc = document.getElementById('floating-calculator');
    const header = document.getElementById('calc-header');
    if (!calc || !header) return;

    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;

    header.onmousedown = dragMouseDown;

    function dragMouseDown(e) {
        e = e || window.event;
        e.preventDefault();
        // get the mouse cursor position at startup:
        pos3 = e.clientX;
        pos4 = e.clientY;
        document.onmouseup = closeDragElement;
        // call a function whenever the cursor moves:
        document.onmousemove = elementDrag;
        header.classList.add('bg-blue-700'); // Visual feedback
    }

    function elementDrag(e) {
        e = e || window.event;
        e.preventDefault();
        // calculate the new cursor position:
        pos1 = pos3 - e.clientX;
        pos2 = pos4 - e.clientY;
        pos3 = e.clientX;
        pos4 = e.clientY;

        // set the element's new position:
        let newTop = calc.offsetTop - pos2;
        let newLeft = calc.offsetLeft - pos1;

        // Constraint within viewport
        const buffer = 10;
        newTop = Math.max(buffer, Math.min(newTop, window.innerHeight - calc.offsetHeight - buffer));
        newLeft = Math.max(buffer, Math.min(newLeft, window.innerWidth - calc.offsetWidth - buffer));

        calc.style.top = newTop + "px";
        calc.style.left = newLeft + "px";
        calc.style.right = 'auto'; // Break existing 'right' style
    }

    function closeDragElement() {
        // stop moving when mouse button is released:
        document.onmouseup = null;
        document.onmousemove = null;
        header.classList.remove('bg-blue-700');
    }
})();

// --- KEYBOARD SUPPORT ---
document.addEventListener('keydown', (e) => {
    const calc = document.getElementById('floating-calculator');
    if (!calc || calc.classList.contains('hidden')) return;

    // Don't capture keys if we're typing in an input or textarea
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable)) {
        return;
    }

    const key = e.key;

    // Numeric keys
    if (/[0-9]/.test(key)) {
        e.preventDefault();
        calcNum(key);
    }
    // Operators
    else if (['+', '-', '*', '/'].includes(key)) {
        e.preventDefault();
        calcOp(key);
    }
    // Equal / Enter
    else if (key === 'Enter' || key === '=') {
        e.preventDefault();
        calcEqual();
    }
    // Clear / Escape
    else if (key === 'Escape') {
        e.preventDefault();
        calcClear();
    }
    // Backspace
    else if (key === 'Backspace') {
        e.preventDefault();
        calcDisplayValue = calcDisplayValue.length > 1 ? calcDisplayValue.slice(0, -1) : '0';
        const display = document.getElementById('calc-display');
        if (display) display.value = calcDisplayValue;
    }
    // Decimal
    else if (key === '.') {
        e.preventDefault();
        calcNum('.');
    }
});


// ===================== SEGMENTED PORTFOLIO REPORTS =====================

/**
 * Internal Helper for Unified Candidate Data Mapping
 * Categorizes and formats candidate objects for cross-segment auditing.
 */
const mapCandidateForAudit = (c) => {
    const job = cachedJobs.find(j => j.id === c.jobId);
    const company = job ? cachedCompanies.find(co => co.id === job.companyId) : null;

    // Segment Identification Logic
    let segment = "Active Pipeline";
    const rejectedStages = ['REJECTED', 'Rejected', 'Backed Out', 'Not Interested', 'Applied'];

    if (c.stage === 'Hired') segment = "Hired Archive";
    else if (c.inTalentPool || rejectedStages.includes(c.stage)) segment = "Talent Pool / Rejections";

    return {
        "Database Segment": segment,
        "Candidate Name": c.name || "N/A",
        "Email": c.email || "N/A",
        "Phone": c.phone || "N/A",
        "Current Stage": c.stage || "Applied",
        "Department": job ? (job.department || "N/A") : "N/A",
        "Job Title": job ? job.title : "N/A",
        "Company": company ? company.name : "N/A",
        "Qualification": c.qualification || "N/A",
        "Experience (Yrs)": c.experience || 0,
        "Current Company": c.currentCompany || "N/A",
        "Designation": c.designation || "N/A",
        "Current CTC (Monthly ₹)": c.currentCTC || 0,
        "Expected CTC (Monthly ₹)": c.expectedCTC || 0,
        "Final / Offered CTC (Monthly ₹)": c.offeredCTC || "TBD",
        "Annual LPA": c.offeredCTC ? +((Number(c.offeredCTC) * 12) / 100000).toFixed(2) : "TBD",
        "Notice Period (Days)": c.noticePeriod || 0,
        "Source": c.source || "N/A",
        "Why Changing": c.whyChangeJob || "N/A",
        "Added Date": c.createdAt ? new Date(c.createdAt.seconds * 1000).toLocaleDateString() : "N/A"
    };
};

/**
 * MASTER RECRUITMENT AUDIT
 * Exports EVERY candidate in the system with their assigned segment.
 */
window.fetchMasterAuditReport = () => {
    if (cachedCandidates.length === 0) return showToast("No data to export.", "warning");
    const data = cachedCandidates.map(mapCandidateForAudit);
    exportToExcel(data, "Master_Portfolio_Audit", "All Candidates");
};

/**
 * ACTIVE PIPELINE SNAPSHOT
 * Exports only candidates currently in progress (not Hired or in Talent Pool).
 */
window.fetchPipelineSnapshotReport = () => {
    const rejectedStages = ['REJECTED', 'Rejected', 'Backed Out', 'Not Interested', 'Applied'];
    const active = cachedCandidates.filter(c => !c.inTalentPool && c.stage !== 'Hired' && !rejectedStages.includes(c.stage));

    if (active.length === 0) return showToast("No active pipeline data.", "info");
    const data = active.map(mapCandidateForAudit);
    exportToExcel(data, "Active_Pipeline_Snapshot", "Pipeline Tracker");
};

/**
 * HIRING SUCCESS & ARCHIVE
 * Exports only candidates marked as 'Hired'.
 */
window.fetchHiringSuccessReport = () => {
    const hired = cachedCandidates.filter(c => c.stage === 'Hired');
    if (hired.length === 0) return showToast("Hired Archive is empty.", "info");
    const data = hired.map(mapCandidateForAudit);
    exportToExcel(data, "Hiring_Success_Archive", "Success Ledger");
};

/**
 * TALENT POOL INSIGHTS
 * Exports raw applications and rejected/archived profiles.
 */
window.fetchTalentPoolInsightsReport = () => {
    const rejectedStages = ['REJECTED', 'Rejected', 'Backed Out', 'Not Interested', 'Applied'];
    const pool = cachedCandidates.filter(c => c.inTalentPool || rejectedStages.includes(c.stage));

    if (pool.length === 0) return showToast("Talent Pool is empty.", "info");
    const data = pool.map(mapCandidateForAudit);
    exportToExcel(data, "Talent_Pool_Rejection_Insights", "Pool Insights");
};


// --- INTERVIEW AUTO-CLEANUP & CALENDAR ---

/**
 * Automatically deletes interview records older than 21 days 
 * if they are in a completed status (Done, Selected, Rejected, etc.)
 */
async function autoCleanupOldInterviews() {
    try {
        const now = new Date();
        const cutoff = new Date(now.getTime() - (21 * 24 * 60 * 60 * 1000)); // 21 days ago

        // Find interviews to delete
        const toDelete = cachedInterviews.filter(i => {
            if (!i.dateTime) return false;
            const interviewDate = new Date(i.dateTime);
            const isOld = interviewDate < cutoff;
            const isCompleted = ['Done', 'Selected', 'Rejected', 'Backed Out', 'Not Interested', 'Interviewed'].includes(i.status);
            return isOld && isCompleted;
        });

        if (toDelete.length > 0) {
            console.log(`Auto-Cleanup: Deleting ${toDelete.length} old interviews.`);
            for (const item of toDelete) {
                await deleteDoc(doc(db, "interviews", item.id));
            }
        }
    } catch (error) {
        console.error("Auto-Cleanup Error:", error);
    }
}

/**
 * Opens a functional Calendar View for interviews
 * Supports monthly grid visualization
 */
window.openInterviewsCalendar = () => {
    const modal = document.getElementById('modal-calendar-view');
    if (!modal) {
        // Fallback: If modal not defined yet, alert
        alert("Calendar View is currently being initialized. Please try again in 1 minute.");
        return;
    }

    // Set default month to current
    const now = new Date();
    renderInterviewsCalendarGrid(now.getFullYear(), now.getMonth());
    openModal('modal-calendar-view');
};

/**
 * Renders a grid-based calendar view of interviews
 */
function renderInterviewsCalendarGrid(year, month) {
    const container = document.getElementById('calendar-grid-container');
    const headerTitle = document.getElementById('calendar-month-title');
    if (!container) return;

    const date = new Date(year, month, 1);
    const monthName = date.toLocaleString('default', { month: 'long' });
    headerTitle.innerText = `${monthName} ${year}`;

    // Get days in month
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const firstDayIndex = date.getDay(); // 0 is Sunday

    let html = '';

    // Day Headers
    ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(day => {
        html += `<div class="calendar-day-header">${day}</div>`;
    });

    // Add empty slots for previous month
    for (let i = 0; i < firstDayIndex; i++) {
        html += `<div class="calendar-day-cell opacity-25"></div>`;
    }

    // Add days
    for (let day = 1; day <= daysInMonth; day++) {
        const currentDateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const dayInterviews = cachedInterviews.filter(i => i.dateTime && i.dateTime.startsWith(currentDateStr));

        let interviewBubbles = '';
        dayInterviews.forEach(i => {
            const cand = cachedCandidates.find(c => c.id === i.candidateId);
            const time = i.dateTime ? new Date(i.dateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
            interviewBubbles += `
                <div class="calendar-interview-bubble" title="${cand ? cand.name : 'Unknown'} @ ${time}">
                    ${time} ${cand ? cand.name : 'Unknown'}
                </div>
            `;
        });

        const isToday = (day === new Date().getDate() && month === new Date().getMonth() && year === new Date().getFullYear());
        const cellClass = `calendar-day-cell ${isToday ? 'is-today' : ''}`;

        html += `
            <div class="${cellClass}">
                <span class="day-number">${day}</span>
                <div class="mt-1">${interviewBubbles}</div>
            </div>
        `;
    }

    container.innerHTML = html;

    // Set navigation buttons
    window.currentCalendarDate = { year, month };
}

window.prevCalendarMonth = () => {
    const { year, month } = window.currentCalendarDate;
    const prevDate = new Date(year, month - 1, 1);
    renderInterviewsCalendarGrid(prevDate.getFullYear(), prevDate.getMonth());
};

window.nextCalendarMonth = () => {
    const { year, month } = window.currentCalendarDate;
    const nextDate = new Date(year, month + 1, 1);
    renderInterviewsCalendarGrid(nextDate.getFullYear(), nextDate.getMonth());
};

/* ==========================================================================
   CONTACTS & DIALER LOGIC
   ========================================================================== */

let dialerCallLogs = JSON.parse(localStorage.getItem('dialerCallLogs') || '[]');

window.renderContactsSection = () => {
    const tableBody = document.getElementById('contacts-table-body');
    if (!tableBody) return;

    // Filter only those marked as contacts
    const contacts = cachedCandidates.filter(c => c.isContact === true);

    if (contacts.length === 0) {
        tableBody.innerHTML = `
            <tr>
                <td colspan="4" class="py-24 text-center">
                    <div class="flex flex-col items-center gap-4 opacity-30">
                        <i class="fas fa-address-book text-5xl"></i>
                        <p class="font-bold uppercase tracking-widest text-xs">No saved contacts yet</p>
                        <p class="text-[10px] max-w-xs mx-auto">Mark candidates as "Save to Contacts" from their profile or the dialer to see them here.</p>
                    </div>
                </td>
            </tr>`;
        return;
    }

    renderContactsTable(contacts);
    renderMiniCallLogs();
};

window.toggleContactStatus = async (id) => {
    const c = cachedCandidates.find(cand => cand.id === id);
    if (!c) return;

    try {
        const newStatus = !c.isContact;
        await updateDoc(doc(db, "candidates", id), { isContact: newStatus });
        if (c.isContact !== newStatus) {
            c.isContact = newStatus;
        }
        renderContactsSection();
        showToast(newStatus ? "Added to Contacts" : "Removed from Contacts");
    } catch (e) {
        console.error("Error toggling contact status:", e);
        showToast("Failed to update contact", "error");
    }
};

window.saveQuickContact = async () => {
    const name = (document.getElementById('quick-contact-name') || {}).value || '';
    const phone = (document.getElementById('quick-contact-phone') || {}).value || '';
    const email = (document.getElementById('quick-contact-email') || {}).value || '';

    if (!name || !phone) {
        return showToast('Name and phone are required to save contact', 'error');
    }

    try {
        const data = {
            name,
            phone,
            email,
            isContact: true,
            createdAt: serverTimestamp(),
            stage: 'Contact',
            inTalentPool: true
        };
        await addDoc(collection(db, 'candidates'), data);
        showToast('Quick contact saved');
        document.getElementById('quick-contact-form').reset();
        renderContactsSection();
        renderWaCandidatesChecklist();
    } catch (e) {
        console.error('Failed saving quick contact', e);
        showToast('Failed saving contact', 'error');
    }
};

function renderContactsTable(contacts) {
    const tableBody = document.getElementById('contacts-table-body');
    const colors = ['bg-blue-500', 'bg-indigo-500', 'bg-purple-500', 'bg-emerald-500', 'bg-rose-500', 'bg-amber-500'];

    tableBody.innerHTML = contacts.map((c, index) => {
        const initials = getInitials(c.name);
        const color = colors[index % colors.length];

        return `
            <tr class="contact-row group">
                <td class="px-4 py-4">
                    <div class="flex items-center gap-3">
                        <div class="contact-avatar ${color}">${initials}</div>
                        <div>
                            <div class="font-bold text-slate-800 dark:text-white">${c.name}</div>
                            <div class="text-[10px] text-slate-500 font-medium">${c.phone || 'No phone'}</div>
                        </div>
                    </div>
                </td>
                <td class="px-4 py-4 text-xs font-medium text-slate-600 dark:text-slate-400">${c.position || 'N/A'}</td>
                <td class="px-4 py-4 text-xs font-medium text-slate-600 dark:text-slate-400">${c.company || 'N/A'}</td>
                <td class="px-4 py-4">
                    <div class="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onclick="quickDial('${c.phone}')" class="action-btn-circle bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400" title="Quick Call">
                            <i class="fas fa-phone"></i>
                        </button>
                        <button onclick="window.open('https://wa.me/91${c.phone}', '_blank')" class="action-btn-circle bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400" title="WhatsApp Message">
                            <i class="fab fa-whatsapp"></i>
                        </button>
                        <button onclick="window.open('mailto:${c.email}', '_blank')" class="action-btn-circle bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400" title="Send Email">
                            <i class="fas fa-envelope"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

window.filterContacts = (term) => {
    const filtered = cachedCandidates.filter(c =>
        c.name.toLowerCase().includes(term.toLowerCase()) ||
        (c.phone && c.phone.includes(term)) ||
        (c.position && c.position.toLowerCase().includes(term.toLowerCase()))
    );
    renderContactsTable(filtered);
};

window.dialPadPush = (val) => {
    const input = document.getElementById('dialer-input');
    if (input.value.length < 15) {
        input.value += val;
        // Trigger input event for any listeners
        input.dispatchEvent(new Event('input', { bubbles: true }));
        // Simple haptic feedback simulation
        if (window.navigator.vibrate) window.navigator.vibrate(10);
    }
};

window.dialPadClear = () => {
    const input = document.getElementById('dialer-input');
    input.value = input.value.slice(0, -1);
};

window.quickDial = (phone) => {
    if (!phone) return showToast("No phone number available");
    const cleanPhone = phone.replace(/\D/g, '');
    document.getElementById('dialer-input').value = cleanPhone;
    initiateDialerCall();
};

window.initiateDialerCall = async () => {
    const phone = document.getElementById('dialer-input').value;
    if (!phone || phone.length < 10) {
        showToast("Please enter a valid phone number");
        return;
    }

    const cleanPhone = phone.replace(/\D/g, '');

    // Add to local logs
    const contact = cachedCandidates.find(c => c.phone && c.phone.replace(/\D/g, '') === cleanPhone);
    const logEntry = {
        name: contact ? contact.name : 'Unknown',
        phone: cleanPhone,
        timestamp: new Date().toISOString(),
        id: Date.now()
    };

    dialerCallLogs.unshift(logEntry);
    if (dialerCallLogs.length > 20) dialerCallLogs.pop();
    localStorage.setItem('dialerCallLogs', JSON.stringify(dialerCallLogs));

    renderMiniCallLogs();

    // Firebase Integration
    await initiateRemoteCall(cleanPhone);
};

async function initiateRemoteCall(phoneNumber) {
    if (!auth.currentUser) return showToast("Please sign in to use the dialer");

    try {
        // Find candidate name from the UI context if possible
        let candidateName = "Manual Dial";
        const immersiveName = document.querySelector('.immersive-workspace .workspace-sidebar h4')?.innerText;
        if (immersiveName && immersiveName !== "New Partner" && immersiveName !== "Candidate Name") {
            candidateName = immersiveName;
        }

        // Use setDoc with User UID as the document ID for the remote dialer app to listen correctly
        await setDoc(doc(db, "remote_calls", auth.currentUser.uid), {
            phoneNumber: phoneNumber,
            candidateName: candidateName,
            status: "pending",
            callerName: auth.currentUser?.displayName || "Recruiter",
            callerEmail: auth.currentUser?.email || "unknown",
            timestamp: serverTimestamp()
        });
        showToast("Request sent to Remote Dialer!");
    } catch (e) {
        console.error("Dialer error:", e);
        showToast("Remote dialer sync failed");
    }
}

function renderMiniCallLogs() {
    const container = document.getElementById('mini-call-logs');
    if (!container) return;

    if (dialerCallLogs.length === 0) {
        container.innerHTML = `<div class="text-center py-6 opacity-40"><i class="fas fa-history text-xl mb-2"></i><p class="text-[10px]">No recent calls</p></div>`;
        return;
    }

    container.innerHTML = dialerCallLogs.map(log => `
        <div class="flex items-center justify-between p-2 rounded-xl bg-white/5 border border-white/5 hover:bg-white/10 transition-all cursor-default">
            <div class="flex items-center gap-3">
                <div class="w-8 h-8 rounded-lg bg-blue-500/20 text-blue-500 flex items-center justify-center text-xs">
                    <i class="fas fa-phone-arrow-up-right"></i>
                </div>
                <div>
                    <div class="text-[11px] font-bold text-slate-700 dark:text-slate-300 truncate max-w-[100px]">${log.name}</div>
                    <div class="text-[9px] text-slate-500">${new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                </div>
            </div>
            <button onclick="quickDial('${log.phone}')" class="text-blue-500 hover:text-blue-600 p-1">
                <i class="fas fa-rotate-right text-[10px]"></i>
            </button>
        </div>
    `).join('');
}

window.clearCallLogs = () => {
    dialerCallLogs = [];
    localStorage.setItem('dialerCallLogs', '[]');
    renderMiniCallLogs();
};

function getInitials(name) {
    if (!name) return "??";
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
}

window.openCandidateModal = () => {
    const form = document.getElementById('form-candidate');
    if (form) form.reset();
    document.getElementById('form-candidate-id').value = '';
    document.getElementById('modal-candidate-title').innerText = 'Add Candidate';
    document.getElementById('cand-name-display').innerText = 'New Candidate';
    document.getElementById('cand-status-display').innerText = 'Draft Mode';
    if (window.updateInitialsDisplay) window.updateInitialsDisplay('');
    if (window.setRating) {
        window.setRating('technical', 0);
        window.setRating('communication', 0);
    }
    if (window.clearResumeSelection) window.clearResumeSelection();
    openModal('modal-candidate');
};

window.updateInitialsDisplay = (name) => {
    const display = document.getElementById('cand-initials-display');
    if (display) display.innerText = getInitials(name);
};

window.setRating = (category, value) => {
    // Target the hidden input by ID: val-rating-technical or val-rating-communication
    const input = document.getElementById(`val-rating-${category}`);
    if (input) input.value = value;

    // Update UI stars
    // The attribute is [onclick="setRating('technical', 1)"] etc.
    const stars = document.querySelectorAll(`[onclick*="setRating('${category}'"]`);
    stars.forEach((star, index) => {
        // Since we are using 1-5 index for clicking, but forEach is 0-indexed
        // Actually the button onclick has the value.
        // Let's just find the value from the onclick attribute.
        const starVal = parseInt(star.getAttribute('onclick').match(/\d+/)[0]);
        if (starVal <= value) {
            star.classList.remove('text-slate-300', 'dark:text-slate-700');
            star.classList.add('text-amber-400');
        } else {
            star.classList.add('text-slate-300', 'dark:text-slate-700');
            star.classList.remove('text-amber-400');
        }
    });
};

/* --- IMMERSIVE WORKSPACE HANDLERS (New) --- */

window.openOfferModal = (id) => {
    const cand = cachedCandidates.find(c => c.id === id);
    if (!cand) return;
    document.getElementById('offer-candidate-id').value = id;
    document.getElementById('offer-cand-name').innerText = cand.name;
    document.getElementById('offer-cand-initials').innerText = getInitials(cand.name);
    document.getElementById('offer-job-title').innerText = cand.jobTitle || 'Active Candidate';
    openModal('modal-offer');
};

document.getElementById('form-offer').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const orig = btn.innerText; btn.innerText = "Processing..."; btn.disabled = true;
    try {
        const formData = new FormData(e.target);
        const data = Object.fromEntries(formData.entries());
        const id = data.candidateId;
        delete data.candidateId;

        // Update Candidate with Offer details
        await updateDoc(doc(db, "candidates", id), {
            ...data,
            stage: 'Offered',
            offerPreparedAt: serverTimestamp()
        });

        showToast("Offer Details Processed!");
        closeModal('modal-offer');
        e.target.reset();
    } catch (e) { alert("Error: " + e.message); }
    finally { btn.innerText = orig; btn.disabled = false; }
};

window.openRejectModal = (id) => {
    const cand = cachedCandidates.find(c => c.id === id);
    if (!cand) return;
    document.getElementById('reject-candidate-id').value = id;
    document.getElementById('reject-cand-name').innerText = cand.name;
    document.getElementById('reject-cand-initials').innerText = getInitials(cand.name);
    openModal('modal-reject');
};

document.getElementById('form-reject').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const orig = btn.innerText; btn.innerText = "Rejecting..."; btn.disabled = true;
    try {
        const formData = new FormData(e.target);
        const data = Object.fromEntries(formData.entries());
        const id = data.candidateId;
        delete data.candidateId;

        await updateDoc(doc(db, "candidates", id), {
            ...data,
            stage: 'Rejected',
            rejectedAt: serverTimestamp()
        });

        showToast("Candidate Rejected.");
        closeModal('modal-reject');
        e.target.reset();
    } catch (e) { alert("Error: " + e.message); }
    finally { btn.innerText = orig; btn.disabled = false; }
};

window.openAssessmentModal = (id) => {
    const cand = cachedCandidates.find(c => c.id === id);
    if (!cand) return;
    document.getElementById('assessment-candidate-id').value = id;
    document.getElementById('assessment-cand-name').innerText = cand.name;
    document.getElementById('assessment-cand-initials').innerText = getInitials(cand.name);
    openModal('modal-assessment');
};

document.getElementById('form-assessment').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const orig = btn.innerText; btn.innerText = "Submitting..."; btn.disabled = true;
    try {
        const formData = new FormData(e.target);
        const data = Object.fromEntries(formData.entries());
        const id = data.candidateId;
        delete data.candidateId;

        await updateDoc(doc(db, "candidates", id), {
            ...data,
            assessmentCompleted: true,
            assessmentAt: serverTimestamp()
        });

        showToast("Assessment Recorded!");
        closeModal('modal-assessment');
        e.target.reset();
    } catch (e) { alert("Error: " + e.message); }
    finally { btn.innerText = orig; btn.disabled = false; }
};

window.openJobModal = () => {
    const form = document.getElementById('form-job');
    if (form) form.reset();
    document.getElementById('form-job-id').value = '';
    document.getElementById('modal-job-title').innerText = 'Job Configuration';
    document.getElementById('job-title-display').innerText = 'New Opening';
    document.getElementById('job-status-display').innerText = 'Drafting Pipeline';
    const budgetMonthly = document.getElementById('job-budget-monthly-imm');
    if (budgetMonthly) budgetMonthly.innerText = '';
    openModal('modal-job');
};

window.openCompanyModal = () => {
    const form = document.getElementById('form-company');
    if (form) form.reset();
    document.getElementById('form-company-id').value = '';
    document.getElementById('modal-company-title').innerText = 'Company Profile';
    document.getElementById('comp-name-display').innerText = 'New Partner';
    document.getElementById('comp-industry-display').innerText = 'Sector Unassigned';
    document.getElementById('comp-logo-display').innerHTML = '<i class="fas fa-city"></i>';
    openModal('modal-company');
};

window.openInterviewModal = (candidateId = '') => {
    const form = document.getElementById('form-interview');
    if (form) form.reset();
    document.getElementById('form-interview-id').value = '';
    document.getElementById('modal-interview-title').innerText = 'Schedule Interview';
    document.getElementById('interview-cand-name-display').innerText = 'Candidate Name';
    document.getElementById('interview-round-display').innerText = 'Round Unassigned';
    document.getElementById('interview-cand-initials').innerHTML = '<i class="fas fa-user"></i>';
    document.getElementById('interview-candidate-search').value = '';
    document.getElementById('interview-candidate-id-hidden').value = '';

    populateInterviewCandidateSearchList();

    if (candidateId) {
        const cand = cachedCandidates.find(c => c.id === candidateId);
        if (cand) {
            const searchInput = document.getElementById('interview-candidate-search');
            const hiddenInput = document.getElementById('interview-candidate-id-hidden');
            if (searchInput) searchInput.value = `${cand.name} | ${cand.phone || ''} | ${cand.email || ''}`;
            if (hiddenInput) hiddenInput.value = cand.id;
            document.getElementById('interview-cand-name-display').innerText = cand.name;
            document.getElementById('interview-cand-initials').innerText = cand.name.charAt(0).toUpperCase();
        }
    }

    openModal('modal-interview');
};

window.populateInterviewCandidateSearchList = () => {
    const list = document.getElementById('candidate-search-list');
    if (!list) return;

    const activeCandidates = cachedCandidates.filter(c => {
        const rejected = ['REJECTED', 'Rejected', 'Backed Out', 'Not Interested'];
        return !rejected.includes(c.stage);
    }).slice(0, 100);

    list.innerHTML = activeCandidates.map(c => `<option value="${c.name} | ${c.phone || ''} | ${c.email || ''}" data-id="${c.id}"></option>`).join('');
};
