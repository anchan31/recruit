import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
    getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    getFirestore, collection, addDoc, setDoc, updateDoc, deleteDoc, doc, getDocs, getDoc, query, where, orderBy, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// --- FIREBASE CONFIG ---
const firebaseConfig = {
    apiKey: "AIzaSyDKuFUJyHUl5AIFSFHCg-4S_wadsha6Et4",
    authDomain: "recruitment-suite-hr.firebaseapp.com",
    projectId: "recruitment-suite-hr",
    storageBucket: "recruitment-suite-hr.firebasestorage.app",
    messagingSenderId: "1049067446272",
    appId: "1:1049067446272:web:a0eb4e5a9fac1589a8f8e5",
    measurementId: "G-87FVXXYEP7"
};


const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// --- STATE MANAGEMENT ---
let currentUser = null;
let cachedCompanies = [];
let cachedJobs = [];
let cachedCandidates = [];
let cachedOffers = [];
let cachedInterviews = [];
let cachedWaTemplates = [];
let cachedTasks = [];
let whatsappSelectedCandidates = new Set();
let globalSearchQuery = '';
let candidateView = 'table'; // 'table' or 'cards'

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
    count += cachedCandidates.filter(c => (c.name || '').toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q) || (c.phone || '').toLowerCase().includes(q)).length;
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
    } else {
        loginView.classList.remove('hidden');
        forgotView.classList.add('hidden');
    }
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
        } finally {
            resetBtn.innerText = orig;
            resetBtn.disabled = false;
        }
    });
}



onAuthStateChanged(auth, async (user) => {
    if (user && !user.isAnonymous) {
        // AUTHORIZATION CHECK
        const allowedEmails = ['hrd@brawnlabs.in', 'talentacq@brawnlabs.in'];
        if (!user.email || !allowedEmails.includes(user.email.toLowerCase())) {
            alert('Access Denied. Only authorized HR personnel can access this dashboard.');
            await auth.signOut();
            return;
        }

        currentUser = user;
        document.getElementById('auth-container').classList.add('hidden');
        document.getElementById('main-app').classList.remove('hidden');


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
        const modal = document.getElementById('modal-inactivity');
        if (modal) modal.classList.add('hidden');
    }
});

// --- CORE DATA FUNCTIONS ---
async function initApp() {
    setupRealtimeListeners();
}

function setupRealtimeListeners() {
    // Listen for Companies
    const compQuery = collection(db, "companies");
    onSnapshot(compQuery, (snapshot) => {
        cachedCompanies = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        renderCompanies();
        renderJobs();
        renderCandidates();
        updateDropdowns();
        if (typeof renderOrganogram === 'function') renderOrganogram();
    });

    // Listen for Jobs
    const jobsQuery = collection(db, "jobs");
    onSnapshot(jobsQuery, (snapshot) => {
        cachedJobs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        renderJobs();
        renderCandidates();
        renderInterviews();
        updateDropdowns();
        updateDashboard();
        if (typeof renderTalentPool === 'function') renderTalentPool();
    });

    // Listen for Candidates
    const candidateQuery = collection(db, "candidates");
    onSnapshot(candidateQuery, (snapshot) => {
        cachedCandidates = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        renderCandidates();
        updateDashboard();
        updateDropdowns();
        if (typeof renderTalentPool === 'function') renderTalentPool();
        if (typeof updateTalentPoolBadge === 'function') updateTalentPoolBadge();
    });

    // Listen for Interviews
    const interviewQuery = collection(db, "interviews");
    onSnapshot(interviewQuery, (snapshot) => {
        cachedInterviews = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        renderInterviews();
        updateDashboard();
    });

    // Listen for Offers
    const offersQuery = query(collection(db, "offers"), orderBy("createdAt", "desc"));
    onSnapshot(offersQuery, (snapshot) => {
        cachedOffers = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        renderOffers();
        updateDashboard();
    });

    // Listen for WhatsApp Templates
    const waQuery = collection(db, "whatsappTemplates");
    onSnapshot(waQuery, (snapshot) => {
        cachedWaTemplates = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        renderWaTemplates();
        updateWaDropdowns();
    });

    // Listen for Tasks
    const taskQuery = query(collection(db, "tasks"), orderBy("createdAt", "desc"));
    onSnapshot(taskQuery, (snapshot) => {
        cachedTasks = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        if (document.getElementById('section-tasks') && !document.getElementById('section-tasks').classList.contains('hidden')) {
            renderTasks();
        }
        updateDashboard();
    });
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

function renderWaCandidatesChecklist() {
    const container = document.getElementById('wa-candidates-checklist');

    // Scoped search filter for WA checklist
    const q = getEffectiveQuery('candidates');
    let list = cachedCandidates.filter(c => {
        if (!q) return true;
        const qn = q.toLowerCase();
        return c.name.toLowerCase().includes(qn) || (c.phone && c.phone.replace(/[^0-9]/g, '').includes(qn.replace(/[^0-9]/g, '')));
    });

    if (list.length === 0) {
        container.innerHTML = `<div class="text-slate-500 text-xs p-2">No candidates found matching the search.</div>`;
        return;
    }

    container.innerHTML = list.map(c => `
                <div class="flex items-center justify-between p-3 hover:bg-slate-500/5 rounded border-b last:border-0" style="border-color: var(--border-color)">
                    <div class="flex items-center gap-3">
                        <input type="checkbox" id="wacand-${c.id}" value="${c.id}" class="wa-cand-checkbox h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" ${whatsappSelectedCandidates.has(c.id) ? 'checked' : ''} onchange="toggleWaCandidate('${c.id}', this.checked)">
                        <label for="wacand-${c.id}" class="text-sm cursor-pointer select-none">
                            <div class="font-bold" style="color: var(--text-primary)">${highlight(c.name, q)}</div>
                            <div class="text-xs" style="color: var(--text-muted)">${c.phone || 'No Phone Number'}</div>
                        </label>
                    </div>
                    <div class="badge badge-gray text-[10px] uppercase font-bold tracking-wider">${c.stage}</div>
                </div>
            `).join('');
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
        previewArea.innerHTML = `<div class="wa-message-bubble">${formatted}</div>`;
    }
};

window.updateLivePreviewOnEdit = () => {
    const content = document.getElementById('wa-template-content').value;
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
    const textarea = document.getElementById('wa-template-content');
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
        const matchStatus = statusFilter === 'all' || j.status === statusFilter;
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
                <div class="glass-card p-6 rounded-2xl border border-slate-200 dark:border-slate-800 hover:border-blue-500/50 transition-all group relative overflow-hidden ${j.status === 'Closed' ? 'opacity-80' : ''}">
                    <div class="flex justify-between items-start mb-4">
                        <div class="flex-1 min-w-0">
                            <div class="flex items-center gap-2 mb-1">
                                <span class="text-[10px] font-bold uppercase tracking-widest ${pColor} px-2 py-0.5 rounded-full">${j.priority || 'Medium'}</span>
                                <span class="text-[10px] font-bold uppercase tracking-widest ${sColor} px-2 py-0.5 rounded-full">${j.status || 'Open'}</span>
                            </div>
                            <h4 class="text-xl font-bold text-slate-800 dark:text-white truncate pr-20">${highlight(j.title, q)}</h4>
                            <p class="text-sm text-blue-500 font-medium">${highlight(company ? company.name : 'Unknown Company', q)}</p>
                        </div>
                        <div class="absolute top-4 right-4 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button onclick="toggleJobStatus('${j.id}', '${j.status}')" class="p-2 ${toggleClass} rounded-lg bg-slate-50 dark:bg-slate-800 shadow-sm border border-slate-100 dark:border-slate-700" title="${toggleTitle}">${toggleIcon}</button>
                            <button onclick="showJobDetails('${j.id}')" class="p-2 text-slate-400 hover:text-blue-500 rounded-lg bg-slate-50 dark:bg-slate-800 shadow-sm border border-slate-100 dark:border-slate-700" title="View Details"><i class="fas fa-info-circle"></i></button>
                            <button onclick="editJob('${j.id}')" class="p-2 text-slate-400 hover:text-blue-500 rounded-lg bg-slate-50 dark:bg-slate-800 shadow-sm border border-slate-100 dark:border-slate-700" title="Edit Job"><i class="fas fa-edit"></i></button>
                            <button onclick="deleteDocById('jobs', '${j.id}')" class="p-2 text-slate-400 hover:text-red-500 rounded-lg bg-slate-50 dark:bg-slate-800 shadow-sm border border-slate-100 dark:border-slate-700" title="Delete Job"><i class="fas fa-trash"></i></button>
                        </div>
                    </div>

                    <div class="grid grid-cols-2 gap-4 mb-6">
                        <div class="flex items-center gap-2 text-xs text-slate-500">
                            <i class="fas fa-layer-group"></i>
                            <span class="truncate">${j.department || 'N/A'}</span>
                        </div>
                        <div class="flex items-center gap-2 text-xs text-slate-500">
                            <i class="fas fa-indian-rupee-sign"></i>
                            <span>₹${j.budget ? (j.budget / 100000).toFixed(1) + 'L' : 'N/A'} <span class="text-[9px] text-blue-500 font-semibold ml-1">${j.budget ? '(₹' + Math.round(j.budget / 12).toLocaleString() + '/mo)' : ''}</span></span>
                        </div>
                    </div>

                    <div class="bg-slate-50 dark:bg-slate-900/40 rounded-xl p-4 mb-6 border border-slate-100 dark:border-slate-800/50">
                        <p class="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-3">Pipeline Overview</p>
                        <div class="grid grid-cols-4 gap-2 text-center">
                            <div>
                                <p class="text-lg font-bold text-slate-800 dark:text-white">${stats.total}</p>
                                <p class="text-[9px] uppercase font-semibold text-slate-500">Total</p>
                            </div>
                            <div class="border-x border-slate-200 dark:border-slate-700">
                                <p class="text-lg font-bold text-blue-500">${stats.active}</p>
                                <p class="text-[9px] uppercase font-semibold text-slate-500">Active</p>
                            </div>
                            <div class="border-r border-slate-200 dark:border-slate-700">
                                <p class="text-lg font-bold text-emerald-500">${stats.hired}</p>
                                <p class="text-[9px] uppercase font-semibold text-slate-500">Hired</p>
                            </div>
                             <div>
                                <p class="text-lg font-bold text-blue-600">${candidatesForJob.filter(c => c.inTalentPool).length}</p>
                                <p class="text-[9px] uppercase font-semibold text-blue-500">Responses</p>
                            </div>
                        </div>
                    </div>

                    <div class="flex gap-2">
                        <button onclick="addCandidateForJob('${j.id}', '${j.department || ''}')" class="flex-1 py-2 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-bold hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors text-slate-700 dark:text-slate-300">Add Candidate</button>
                        <button onclick="viewJobInbox('${j.id}')" class="flex-1 py-2 rounded-lg bg-emerald-600 text-white text-xs font-bold hover:bg-emerald-700 transition-colors shadow-sm">Manage Responses</button>
                        <button onclick="viewJobPipeline(this)" data-jobid="${j.id}" data-jobtitle="${j.title}" class="flex-1 py-2 rounded-lg bg-blue-600 text-white text-xs font-bold hover:bg-blue-700 transition-colors shadow-sm">View Pipeline</button>
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

function renderInterviews() {
    const container = document.getElementById('interviews-list');
    const q = getEffectiveQuery('interviews');
    const qnorm = q ? q.toLowerCase() : '';
    const filtered = cachedInterviews.filter(i => {
        const cand = cachedCandidates.find(c => c.id === i.candidateId);
        if (!cand) return false;
        if (!qnorm) return true;
        return cand.name.toLowerCase().includes(qnorm) || (i.interviewer && i.interviewer.toLowerCase().includes(qnorm)) || (cand.phone && cand.phone.replace(/[^0-9]/g, '').includes(qnorm.replace(/[^0-9]/g, '')));
    });

    if (filtered.length === 0) {
        container.innerHTML = '<div class="text-slate-400 p-4 col-span-2">No interviews matching search.</div>';
        return;
    }

    container.innerHTML = filtered.map(i => {
        const cand = cachedCandidates.find(c => c.id === i.candidateId);
        const date = i.dateTime ? new Date(i.dateTime).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'TBD';
        const status = i.status || 'Scheduled';
        let borderClass = 'border-blue-500';
        let badgeClass = 'badge badge-blue';

        if (status === 'Done' || status === 'Interviewed') { borderClass = 'border-slate-300 dark:border-slate-500'; badgeClass = 'badge badge-gray'; }
        if (status === 'Selected') { borderClass = 'border-green-500'; badgeClass = 'badge badge-green'; }
        if (status === 'Rejected' || status === 'Backed Out' || status === 'Not Interested') { borderClass = 'border-red-500'; badgeClass = 'badge badge-red'; }

        return `
            <div class="glass-card p-6 rounded-xl border-l-4 ${borderClass} flex flex-col justify-between group">
                <div class="flex justify-between items-start">
                    <div>
                        <div class="flex items-center gap-3">
                            <h4 class="font-bold text-xl text-slate-800 dark:text-white">${highlight(cand ? cand.name : 'Unknown Candidate', q)}</h4>
                            <span class="text-[10px] px-2 py-0.5 rounded border uppercase font-bold tracking-wider ${badgeClass}">${status}</span>
                        </div>
                        <p class="text-sm mt-1.5 font-medium" style="color: var(--text-secondary)"><i class="far fa-clock mr-2 text-slate-400"></i>${date}</p>
                        <p class="text-xs mt-1 lowercase font-bold tracking-tight" style="color: var(--text-muted)"><i class="fas ${i.mode && i.mode.includes('Video') ? 'fa-video text-blue-500' : 'fa-building text-orange-500'} mr-2"></i> ${i.mode || ''}</p>
                        ${i.interviewer ? `<p class="text-[10px] mt-2 italic font-medium" style="color: var(--text-muted)"><i class="fas fa-user-circle mr-1"></i> Interviewer: ${i.interviewer}</p>` : ''}
                    </div>
                    <div class="flex flex-col gap-2">
                        <button onclick="editInterview('${i.id}')" class="text-slate-400 hover:text-blue-500 p-2 opacity-0 group-hover:opacity-100 transition" title="Edit Interview"><i class="fas fa-edit"></i></button>
                        <button onclick="deleteDocById('interviews', '${i.id}')" class="text-slate-400 hover:text-red-500 p-2 opacity-0 group-hover:opacity-100 transition" title="Delete Interview"><i class="fas fa-trash"></i></button>
                    </div>
                </div>
                <!--Template Send Controls-->
            <div class="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 flex justify-between items-center transition-all">
                <div class="flex-1 mr-4 relative">
                    <!-- We use no-custom-select here if we want native, or skip it to get shiny custom selects -->
                    <select id="template-select-${i.id}" class="theme-input text-xs py-1.5 px-2 rounded-lg w-full bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-700 no-custom-select" style="max-width: 180px;">
                        <option value="">-- Choose Msg Template --</option>
                        ${cachedWaTemplates.filter(t => t.type === 'Interview Reminder').map(t => `<option value="${t.id}">${t.name}</option>`).join('')}
                    </select>
                </div>
                <div class="flex gap-2 shrink-0">
                    <button onclick="sendInterviewWhatsApp('${i.id}')" class="w-8 h-8 flex items-center justify-center bg-[#25D366] hover:bg-[#128C7E] text-white rounded-full shadow-sm shadow-[#25D366]/20 transition-colors" title="Send WhatsApp">
                        <i class="fab fa-whatsapp text-sm"></i>
                    </button>
                    <button onclick="sendInterviewEmail('${i.id}')" class="w-8 h-8 flex items-center justify-center bg-slate-700 hover:bg-slate-800 dark:bg-slate-600 dark:hover:bg-slate-500 text-white rounded-full shadow-sm transition-colors" title="Send Email">
                        <i class="fas fa-envelope text-sm"></i>
                    </button>
                </div>
            </div>
            </div>
            `;
    }).join('');
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
    const todayStr = new Date().toISOString().split('T')[0];
    const todayInts = cachedInterviews.filter(i => i.dateTime && i.dateTime.startsWith(todayStr)).length;
    document.getElementById('stat-today-interviews').innerText = todayInts;

    // Pending Tasks (Roadmap v2)
    const pendingTasks = cachedTasks.filter(t => (t.status || 'todo').toLowerCase() !== 'done').length;
    const ptEl = document.getElementById('stat-pending-tasks');
    if (ptEl) ptEl.innerText = pendingTasks;

    // Talent Pool (Candidates not hired/rejected/backed out/not interested)
    const talentPool = cachedCandidates.filter(c => c.stage !== 'Hired' && c.stage !== 'Rejected' && c.stage !== 'Backed Out' && c.stage !== 'Not Interested').length;
    const tpEl = document.getElementById('stat-talent-pool');
    if (tpEl) tpEl.innerText = talentPool;

    // Headcount (Hired candidates)
    const headcount = cachedCandidates.filter(c => c.stage === 'Hired').length;
    const hcEl = document.getElementById('stat-headcount');
    if (hcEl) hcEl.innerText = headcount;

    // Open Offers: now computed from cachedOffers below (after renderDashboardOffers call)

    // Selection Rate
    const selectedCount = cachedCandidates.filter(c => c.stage === 'Selected' || c.stage === 'Hired').length;
    const selectionRate = totalCandidates > 0 ? Math.round((selectedCount / totalCandidates) * 100) : 0;
    document.getElementById('stat-selection-rate').innerText = selectionRate + '%';

    // Budget Adherence & Median CTC
    let withinBudgetCount = 0;
    let totalCandWithJob = 0;
    let ctcs = [];

    cachedCandidates.forEach(c => {
        const job = cachedJobs.find(j => j.id === c.jobId);
        const expCTC = Number(c.expectedCTC || c.expectedSalary || 0); // monthly
        const annualExpCTC = expCTC * 12; // annualise for budget comparison
        if (expCTC > 0) ctcs.push(expCTC); // keep monthly for median stat

        if (job) {
            let jobBudget = job.budget ? Number(job.budget) : (job.budgetMax ? Number(job.budgetMax) : 0); // annual
            if (jobBudget > 0 && annualExpCTC > 0) {
                totalCandWithJob++;
                if (annualExpCTC <= jobBudget) withinBudgetCount++;
            }
        }
    });

    const adherence = totalCandWithJob > 0 ? Math.round((withinBudgetCount / totalCandWithJob) * 100) : 100;
    const bEl = document.getElementById('stat-avg-budget');
    if (bEl) {
        bEl.innerText = adherence + '%';
        bEl.className = `text-xl font-bold mt-1 ${adherence >= 80 ? 'text-green-500' : adherence >= 50 ? 'text-orange-500' : 'text-red-500'} `;
    }

    // Median CTC calculation (stored as monthly → display as annual LPA for context)
    ctcs.sort((a, b) => a - b);
    let median = 0;
    if (ctcs.length > 0) {
        const mid = Math.floor(ctcs.length / 2);
        median = ctcs.length % 2 !== 0 ? ctcs[mid] : (ctcs[mid - 1] + ctcs[mid]) / 2;
    }
    const medianAnnual = median * 12;
    document.getElementById('stat-median-ctc').innerText = medianAnnual ? `₹${(medianAnnual / 100000).toFixed(1)} L` : '₹0';

    // Monthly Hires (ONLY count 'Hired' stage as per user request)
    const currentMonth = new Date().getMonth();
    const currentYear = new Date().getFullYear();
    const monthlyHires = cachedCandidates.filter(c => {
        if (c.stage !== 'Hired') return false;

        // Use hiredAt if available, fallback to createdAt
        const timestamp = c.hiredAt || c.createdAt;
        if (!timestamp) return false;

        const d = new Date(timestamp.seconds * 1000);
        return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
    }).length;
    document.getElementById('stat-monthly-hires').innerText = monthlyHires;

    // Offer to Join Ratio
    const hiredCount = cachedCandidates.filter(c => c.stage === 'Hired').length;
    const selectedOffers = cachedCandidates.filter(c => c.stage === 'Selected').length;
    const totalOffers = hiredCount + selectedOffers;
    const joinRatio = totalOffers > 0 ? Math.round((hiredCount / totalOffers) * 100) : 0;

    const joinRatioEl = document.getElementById('stat-join-ratio');
    if (joinRatioEl) {
        joinRatioEl.innerText = joinRatio + '%';
    }

    // Pipeline Distribution Chart
    const stages = ['Applied', 'Screening', 'Interview', 'Selected', 'Hired', 'Rejected', 'Backed Out', 'Not Interested'];
    const stageCounts = stages.map(s => cachedCandidates.filter(c => c.stage === s).length);

    if (stageChartInstance) stageChartInstance.destroy();
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
                y: {
                    beginAtZero: true,
                    grid: { color: 'rgba(51, 65, 85, 0.1)', borderDash: [5, 5] },
                    ticks: { font: { size: 10 } }
                },
                x: {
                    grid: { display: false },
                    ticks: { font: { size: 10, weight: 'bold' } }
                }
            }
        }
    });

    // Source Distribution Chart (Dynamic from Candidate Data)
    const sourceMap = {};
    cachedCandidates.forEach(c => {
        const s = c.source || 'Other';
        sourceMap[s] = (sourceMap[s] || 0) + 1;
    });

    const sortedSources = Object.entries(sourceMap)
        .sort((a, b) => b[1] - a[1]);

    // Take top 5, rest as Other
    const topSources = sortedSources.slice(0, 5);
    const otherCount = sortedSources.slice(5).reduce((acc, curr) => acc + curr[1], 0);

    let chartLabels = topSources.map(s => s[0]);
    let chartData = topSources.map(s => s[1]);

    if (otherCount > 0) {
        chartLabels.push('Other');
        chartData.push(otherCount);
    }

    if (sourceChartInstance) sourceChartInstance.destroy();
    sourceChartInstance = new Chart(document.getElementById('sourceChart'), {
        type: 'doughnut',
        data: {
            labels: chartLabels,
            datasets: [{
                data: chartData,
                backgroundColor: ['#3b82f6', '#8b5cf6', '#f59e0b', '#10b981', '#ef4444', '#94a3b8'],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '70%',
            plugins: {
                legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } }
            }
        }
    });

    // Trends Chart (Budget vs Real CTCs)
    const recentJobs = cachedJobs.slice(0, 6);
    const jobLabels = recentJobs.map(j => j.title.length > 15 ? j.title.substring(0, 12) + '...' : j.title);
    const budgetData = recentJobs.map(j => j.budget ? Number(j.budget) : (j.budgetMax ? Number(j.budgetMax) : 0)); // annual
    const avgExpData = recentJobs.map(j => {
        const candidatesForJob = cachedCandidates.filter(c => c.jobId === j.id);
        if (candidatesForJob.length === 0) return 0;
        // monthly → annual to match job budget scale
        const avgMonthly = candidatesForJob.reduce((acc, c) => acc + Number(c.expectedCTC || c.expectedSalary || 0), 0) / candidatesForJob.length;
        return avgMonthly * 12;
    });

    if (budgetChartInstance) budgetChartInstance.destroy();
    budgetChartInstance = new Chart(document.getElementById('budgetChart'), {
        type: 'line',
        data: {
            labels: jobLabels,
            datasets: [
                { label: 'Job Budget (Annual)', data: budgetData, borderColor: '#10b981', backgroundColor: 'rgba(16, 185, 129, 0.1)', fill: true, tension: 0.4 },
                { label: 'Avg Expected CTC (Annual)', data: avgExpData, borderColor: '#ef4444', borderDash: [5, 5], tension: 0.4 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'top', labels: { boxWidth: 15, font: { size: 11 } } } },
            scales: {
                y: {
                    grid: { color: 'rgba(51, 65, 85, 0.1)' },
                    ticks: { callback: (val) => '₹' + (val / 100000).toFixed(1) + 'L' }
                }
            }
        }
    });

    renderUpcomingInterviews();
    renderDashboardTasks();
    renderDashboardOffers();
    renderHiringFunnel();

    // Refresh notification badge whenever data changes
    if (typeof refreshNotificationBadge === 'function') refreshNotificationBadge();

    // ── New stats powered by cachedOffers ──
    const pendingOffers = cachedOffers.filter(o => !o.status || o.status === 'Pending' || o.status === 'Sent');
    const signedOffers = cachedOffers.filter(o => o.status === 'Signed' || o.status === 'Accepted');
    const ooEl2 = document.getElementById('stat-open-offers');
    if (ooEl2) ooEl2.innerText = pendingOffers.length;
    const signedEl = document.getElementById('stat-offers-signed');
    if (signedEl) signedEl.innerText = signedOffers.length;

    // ── Avg Experience ──
    const expValues = cachedCandidates.map(c => Number(c.experience || 0)).filter(v => v > 0);
    const avgExp = expValues.length > 0 ? (expValues.reduce((a, b) => a + b, 0) / expValues.length).toFixed(1) : 0;
    const aeEl = document.getElementById('stat-avg-exp');
    if (aeEl) aeEl.innerText = avgExp;

    // ── Overdue Tasks ──
    const todayISO = new Date().toISOString().split('T')[0];
    const overdueTasks = cachedTasks.filter(t => {
        if ((t.status || 'todo').toLowerCase() === 'done') return false;
        return t.dueDate && t.dueDate < todayISO;
    }).length;
    const otEl = document.getElementById('stat-overdue-tasks');
    if (otEl) otEl.innerText = overdueTasks;
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

    container.innerHTML = futureInts.slice(0, 10).map(i => {
        const cand = cachedCandidates.find(c => c.id === i.candidateId);
        const job = cand ? cachedJobs.find(j => j.id === cand.jobId) : null;
        const dt = new Date(i.dateTime);
        const timeStr = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const dateStr = dt.toLocaleDateString([], { day: 'numeric', month: 'short' });

        return `
            <div class="p-4 rounded-xl bg-white dark:bg-slate-800/40 border border-slate-100 dark:border-slate-800 hover:border-blue-500/30 transition-colors group">
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

function renderDashboardTasks() {
    const container = document.getElementById('dashboard-tasks-list');
    if (!container) return;

    const pending = cachedTasks
        .filter(t => (t.status || 'todo').toLowerCase() !== 'done')
        .sort((a, b) => {
            const priorities = { 'Urgent': 0, 'High': 1, 'Medium': 2, 'Low': 3 };
            return priorities[a.priority] - priorities[b.priority];
        });

    if (pending.length === 0) {
        container.innerHTML = `<div class="text-center py-8 text-slate-400 text-xs italic" > All caught up! No pending tasks.</div>`;
        return;
    }

    container.innerHTML = pending.slice(0, 5).map(t => {
        const priorityClass = { 'Low': 'text-slate-400', 'Medium': 'text-blue-500', 'High': 'text-orange-500', 'Urgent': 'text-red-500' }[t.priority] || 'text-slate-400';
        return `
            <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/20 border border-slate-100 dark:border-slate-800 hover:border-blue-500/20 transition-all group">
                <div class="flex items-start gap-3">
                    <div class="mt-1"><i class="fas fa-circle ${priorityClass} text-[6px]"></i></div>
                    <div class="flex-1">
                        <p class="text-xs font-bold text-slate-700 dark:text-slate-200">${t.title}</p>
                        <div class="flex justify-between items-center mt-1">
                            <span class="text-[9px] text-slate-400">Due: ${t.dueDate || 'N/A'}</span>
                            <button onclick="moveTask('${t.id}', 'done')" class="text-[9px] font-bold text-blue-500 hover:underline opacity-0 group-hover:opacity-100 transition-opacity uppercase">Complete</button>
                        </div>
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
    document.getElementById('form-company-id').value = id;
    document.getElementById('modal-company-title').innerText = "Edit Company";
    openModal('modal-company');
};

document.getElementById('form-job').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const orig = btn.innerText; btn.innerText = "Saving..."; btn.disabled = true;
    try {
        const formData = new FormData(e.target);
        const data = Object.fromEntries(formData.entries());

        // Keep budget numeric
        data.budget = Number(data.budget);

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
    openModal('modal-candidate');
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
        try { element.value = value == null ? '' : value; } catch (e) { /* ignore */ }
    }

    for (const key in job) {
        const el = form.elements[key];
        if (!el) continue;

        // Handle collections (multiple elements with same name)
        if (el.length && !el.tagName) {
            for (let i = 0; i < el.length; i++) {
                populateElement(el[i], job[key]);
            }
        } else {
            populateElement(el, job[key]);
        }
    }

    // Refresh custom select UI to reflect populated values
    try { initCustomSelects(); } catch (e) { console.warn('initCustomSelects in editJob failed', e); }
    // Ensure location is set according to company after population (override intentionally)
    try { prefillJobLocationFromCompany(); } catch (e) { /* ignore */ }
    document.getElementById('form-job-id').value = id;
    openModal('modal-job');
};

// Cloudinary Config
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
    formData.append('upload_preset', CLOUDINARY_PRESET);
    formData.append('resource_type', 'raw'); // Better for Docs/PDFs
    formData.append('folder', 'resume_uploads');
    if (publicId) formData.append('public_id', publicId);

    console.log('Uploading to Cloudinary...', { url: CLOUDINARY_URL, preset: CLOUDINARY_PRESET });

    try {
        const res = await fetch(CLOUDINARY_URL.replace('/auto/', '/raw/'), {
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
    form.reset();

    for (const key in cand) {
        if (form.elements[key]) {
            form.elements[key].value = cand[key];
        }
    }

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
    document.getElementById('resumeFileInput').value = '';
    document.getElementById('resumeFileLabel').innerText = 'Select File...';
    document.getElementById('resume-upload-status').innerHTML = '';
    const existingActions = document.getElementById('existing-resume-actions');

    if (cand.resumeUrl) {
        existingActions.classList.remove('hidden');
        document.getElementById('resumeUrlHidden').value = cand.resumeUrl;
    } else {
        existingActions.classList.add('hidden');
        document.getElementById('resumeUrlHidden').value = '';
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

        // SYNC: Update candidate stage in database
        if (candidateId && data.status) {
            // Do not change status if candidate is already Selected or has exited the process
            if (currentStage !== "Selected" && currentStage !== "Rejected" && currentStage !== "Backed Out" && currentStage !== "Not Interested") {
                let newStage = currentStage;

                if (data.status === "Selected") newStage = "Selected";
                else if (data.status === "Rejected") newStage = "Rejected";
                else if (data.status === "Backed Out") newStage = "Backed Out";
                else if (data.status === "Not Interested") newStage = "Not Interested";
                else if (data.status === "Scheduled" || data.status === "Interviewed" || data.status === "On Hold") newStage = "Interview";

                if (newStage !== currentStage) {
                    await updateDoc(doc(db, "candidates", candidateId), { stage: newStage });
                }
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
    const match = cachedCandidates.find(c => {
        const searchStr = `${c.name} | ${c.phone || ''} | ${c.email} `.toLowerCase();
        return searchStr === val.toLowerCase();
    });
    if (match) {
        document.getElementById('interview-candidate-id-hidden').value = match.id;
    } else {
        document.getElementById('interview-candidate-id-hidden').value = '';
    }
};

window.syncInterviewCandidateId = (val) => {
    const option = Array.from(document.getElementById('candidate-search-list').options).find(opt => opt.value === val);
    if (option) {
        document.getElementById('interview-candidate-id-hidden').value = option.getAttribute('data-id');
    } else {
        document.getElementById('interview-candidate-id-hidden').value = '';
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
        document.getElementById('interview-candidate-search').value = `${cand.name} | ${cand.phone || ''} | ${cand.email} `;
        document.getElementById('interview-candidate-id-hidden').value = cand.id;
    }

    document.getElementById('form-interview-id').value = id;
    document.getElementById('modal-interview-title').innerText = "Edit Interview";
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
        const updateData = { stage, inTalentPool: false, isNew: false };
        if (stage === 'Hired') {
            updateData.hiredAt = serverTimestamp();

            // Legacy: we'll remove this field after cleanup
            // updateData.offerStatus = 'Sent'; 

            const cand = cachedCandidates.find(c => c.id === id);
            const job = cand ? cachedJobs.find(j => j.id === cand.jobId) : null;

            await addDoc(collection(db, "offers"), {
                candidateId: id,
                candidateName: cand ? cand.name : 'Unknown',
                jobId: cand ? cand.jobId : null,
                jobTitle: job ? job.title : 'Position Unknown',
                status: 'Sent',
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
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
    } finally {
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
                    <label class="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 font-medium whitespace-nowrap">
                        <input type="checkbox" id="adv-opt-ctc" checked class="rounded text-blue-600 focus:ring-blue-500 w-4 h-4 bg-white border-gray-300 border"> Include Financials (CTC)
                    </label>
                    <label class="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 font-medium whitespace-nowrap">
                        <input type="checkbox" id="adv-opt-contact" checked class="rounded text-blue-600 focus:ring-blue-500 w-4 h-4 bg-white border-gray-300 border"> Include Contact Info
                    </label>
                `;
    } else if (advReportType === 'jobs') {
        const depts = [...new Set(cachedJobs.map(j => j.department).filter(Boolean))];
        const statuses = ['Open', 'Closed'];

        html += createFilterDropdown('Department', 'dept', depts);
        html += createFilterDropdown('Status', 'status', statuses);

        document.getElementById('advanced-report-options-container').innerHTML = `
                    <label class="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 font-medium whitespace-nowrap">
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
                    <label class="block text-xs font-bold text-slate-500 dark:text-slate-400 mb-2 uppercase tracking-wider">${label}</label>
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

// --- UTILS ---
window.showSection = (sectionId) => {
    document.querySelectorAll('#content-area > div').forEach(div => div.classList.add('hidden'));
    const sectionEl = document.getElementById(`section-${sectionId}`);
    if (sectionEl) sectionEl.classList.remove('hidden');

    document.querySelectorAll('.sidebar-btn').forEach(btn => btn.classList.remove('sidebar-item-active'));
    const navBtn = document.getElementById(`btn-nav-${sectionId}`);
    if (navBtn) navBtn.classList.add('sidebar-item-active');

    const titles = {
        'dashboard': 'Dashboard',
        'tasks': 'HR Task Board',
        'companies': 'Companies',
        'jobs': 'Job Openings',
        'candidates': 'Candidates',
        'talentpool': 'Talent Pool',
        'interviews': 'Interviews',
        'offers': 'Offer Management',
        'organogram': 'Corporate Organogram',
        'messaging': 'Communications',
        'reports': 'Reports & Data Export',
        'portalsettings': 'Portal Customization'
    };

    const titleEl = document.getElementById('section-title');
    if (titleEl) titleEl.innerText = titles[sectionId] || (sectionId.charAt(0).toUpperCase() + sectionId.slice(1));

    // Ensure the visible section is rendered/refreshed so filters take effect
    switch (sectionId) {
        case 'dashboard':
            updateDashboard();
            break;
        case 'tasks':
            renderTasks();
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
        case 'interviews':
            renderInterviews();
            break;
        case 'offers':
            renderOffers();
            break;
        case 'organogram':
            renderOrganogram();
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
        default:
            break;
    }
};


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

// --- TASK BOARD LOGIC ---
window.renderTasks = () => {
    const columns = { 'todo': document.getElementById('kanban-todo'), 'inprogress': document.getElementById('kanban-inprogress'), 'done': document.getElementById('kanban-done') };
    const counts = { 'todo': document.getElementById('count-todo'), 'inprogress': document.getElementById('count-inprogress'), 'done': document.getElementById('count-done') };
    Object.values(columns).forEach(col => { if (col) col.innerHTML = ''; });
    const listCounts = { 'todo': 0, 'inprogress': 0, 'done': 0 };

    cachedTasks.forEach(task => {
        const status = (task.status || 'todo').toLowerCase().replace(' ', '');
        if (columns[status]) {
            listCounts[status]++;
            const priorityClass = { 'Low': 'bg-slate-100', 'Medium': 'bg-blue-50', 'High': 'bg-orange-50', 'Urgent': 'bg-red-50' }[task.priority] || 'bg-slate-100';
            const next = { 'todo': { label: 'Start', n: 'inprogress' }, 'inprogress': { label: 'Done', n: 'done' }, 'done': { label: 'Reopen', n: 'todo' } }[status];
            columns[status].innerHTML += `
                        <div class="glass-card p-4 rounded-xl border border-slate-200 mb-3 animate-in fade-in group">
                            <div class="flex justify-between items-start">
                                <span class="text-[8px] font-bold uppercase px-2 py-0.5 rounded-full ${priorityClass}">${task.priority}</span>
                                <div class="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <button onclick="editTask('${task.id}')" class="text-slate-400 hover:text-blue-500 transition" title="Edit Task"><i class="fas fa-edit text-[10px]"></i></button>
                                    <button onclick="deleteDocById('tasks', '${task.id}')" class="text-slate-400 hover:text-red-500 transition" title="Delete Task"><i class="fas fa-trash text-[10px]"></i></button>
                                </div>
                            </div>
                            <h5 class="text-sm font-bold mt-2">${task.title}</h5>
                            <div class="flex justify-between items-center mt-4 pt-2 border-t border-slate-100">
                                <span class="text-[9px] text-slate-500">${task.dueDate || 'No date'}</span>
                                <button onclick="moveTask('${task.id}', '${next.n}')" class="text-[9px] font-bold uppercase text-blue-500 hover:underline">${next.label}</button>
                            </div>
                        </div>`;
        }
    });
    Object.keys(counts).forEach(k => { if (counts[k]) counts[k].innerText = listCounts[k]; });
};

window.openAddTaskModal = () => {
    const form = document.getElementById('form-task');
    if (form) form.reset();
    const idInput = document.getElementById('form-task-id');
    if (idInput) idInput.value = '';
    openModal('modal-task');
};

window.editTask = (id) => {
    const task = cachedTasks.find(t => t.id === id);
    if (!task) return;
    const form = document.getElementById('form-task');
    if (form) form.reset();

    const idInput = document.getElementById('form-task-id');
    if (idInput) idInput.value = id;

    if (form.elements['title']) form.elements['title'].value = task.title || '';
    if (form.elements['priority']) form.elements['priority'].value = task.priority || 'Medium';
    if (form.elements['dueDate']) form.elements['dueDate'].value = task.dueDate || '';

    openModal('modal-task');
};

window.moveTask = async (id, status) => {
    try { await updateDoc(doc(db, "tasks", id), { status }); showToast("Moved"); } catch (e) { showError("Failed"); }
};

window.renderOffers = () => {
    const list = document.getElementById('offers-list');
    if (!list) return;

    const q = getEffectiveQuery('offers');
    const filteredOffers = q ? cachedOffers.filter(o =>
        (o.candidateName || '').toLowerCase().includes(q) ||
        (o.jobTitle || '').toLowerCase().includes(q)
    ) : cachedOffers;

    if (filteredOffers.length === 0) {
        list.innerHTML = `<div class="col-span-full py-10 text-center text-slate-400 font-medium">No pending offers.</div>`;
        return;
    }

    list.innerHTML = filteredOffers.map(o => {
        const status = o.status || 'Pending';
        const statusClass = status === 'Signed' ? 'bg-emerald-100 text-emerald-700' : (status === 'Sent' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600');

        return `
                <div class="glass-card p-6 rounded-2xl border border-slate-200 dark:border-slate-800 hover:shadow-lg transition-all">
                    <div class="flex justify-between items-start mb-4">
                        <div class="w-12 h-12 rounded-xl bg-blue-50 dark:bg-blue-900/20 flex items-center justify-center font-bold text-blue-600 text-xl shadow-sm italic">
                            ${(o.candidateName || '?')[0]}
                        </div>
                        <span class="text-[10px] font-bold uppercase px-3 py-1 ${statusClass} rounded-full transition-all tracking-wider font-mono">
                            ${status}
                        </span>
                    </div>
                    
                    <div class="space-y-1">
                        <h4 class="font-bold text-slate-800 dark:text-white text-base leading-tight">
                            ${highlight(o.candidateName || 'Unknown', getEffectiveQuery('offers'))}
                        </h4>
                        <p class="text-xs text-slate-500 font-medium flex items-center gap-1.5">
                            <i class="fas fa-briefcase text-[10px] opacity-70"></i>
                            ${o.jobTitle || 'Position Unknown'}
                        </p>
                    </div>

                    <div class="mt-6 pt-5 border-t border-slate-50 dark:border-slate-800/50 flex gap-3">
                        ${status === 'Pending' ? `
                            <button onclick="updateOfferStatus('${o.id}', 'Sent')" class="flex-1 py-2.5 text-[10px] font-bold uppercase bg-blue-600 hover:bg-blue-700 text-white rounded-xl shadow-lg shadow-blue-500/20 transition-all active:scale-95">
                                <i class="fas fa-paper-plane mr-1.5"></i> Mark as Sent
                            </button>
                        ` : ''}
                        ${status === 'Sent' ? `
                            <button onclick="updateOfferStatus('${o.id}', 'Signed')" class="flex-1 py-2.5 text-[10px] font-bold uppercase bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl shadow-lg shadow-emerald-500/20 transition-all active:scale-95">
                                <i class="fas fa-file-signature mr-1.5"></i> Mark as Signed
                            </button>
                        ` : ''}
                        ${status === 'Signed' ? `
                            <div class="w-full py-2 text-center text-[10px] font-bold uppercase text-emerald-500 bg-emerald-50 dark:bg-emerald-900/20 rounded-xl border border-emerald-100 dark:border-emerald-800/50">
                                <i class="fas fa-check-circle mr-1.5"></i> Offer Completed
                            </div>
                        ` : ''}
                    </div>
                </div>`;
    }).join('');
};

window.updateOfferStatus = async (id, status) => {
    try {
        await updateDoc(doc(db, "offers", id), {
            status: status,
            updatedAt: serverTimestamp()
        });
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
        const DEFAULT_STEPS = [
            { id: 'personal', label: 'Personal Details', icon: 'fa-user', desc: 'Name, email, phone, gender, address' },
            { id: 'professional', label: 'Professional Details', icon: 'fa-briefcase', desc: 'Company, designation, experience' },
            { id: 'position', label: 'Applied Position', icon: 'fa-layer-group', desc: 'Department & job selection' },
            { id: 'financials', label: 'CTC & Financials', icon: 'fa-indian-rupee-sign', desc: 'Current CTC, expected CTC, notice period' },
            { id: 'resume', label: 'Resume Upload', icon: 'fa-file-lines', desc: 'PDF/DOC upload via Cloudinary' },
            { id: 'review', label: 'Review & Submit', icon: 'fa-circle-check', desc: 'Final review before submission' }
        ];

        const rawData = docSnap.exists() ? docSnap.data() : {};

        // Merge defaults so steps always exist even for older Firestore docs
        const savedSteps = rawData.steps || [];
        const mergedSteps = DEFAULT_STEPS.map(def => {
            const saved = savedSteps.find(s => s.id === def.id);
            return { ...def, enabled: saved ? saved.enabled : true };
        });

        const data = {
            companyPrompt: 'Join our team!',
            primaryColor: '#3b82f6',
            isLocked: false,
            openCompanies: [],
            openDepartments: [],
            openPositions: [],
            logoUrl: '',
            backgroundUrl: '',
            fontFamily: 'Inter, sans-serif',
            fields: {
                phone: { required: true },
                currentCTC: { required: true },
                expectedCTC: { required: true },
                noticePeriod: { required: true }
            },
            ...rawData,
            steps: mergedSteps
        };

        // Build company/dept/position lists
        const allCompanies = cachedCompanies.map(c => ({ id: c.id, name: c.name || c.id })).sort((a, b) => a.name.localeCompare(b.name));
        const allDepts = [...new Set(cachedJobs.map(j => j.department).filter(Boolean))].sort();
        const allPositions = [...new Set(cachedJobs.map(j => j.title).filter(Boolean))].sort();

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
                            </div>
                            <div class="flex items-center gap-4 bg-slate-50 dark:bg-slate-800/50 p-3 rounded-2xl border border-slate-100 dark:border-slate-800">
                                <span class="text-xs font-bold uppercase tracking-widest text-slate-400">Portal Status</span>
                                <label class="relative inline-flex items-center cursor-pointer">
                                    <input type="checkbox" name="isLocked" class="sr-only peer" ${data.isLocked ? 'checked' : ''}>
                                    <div class="w-14 h-7 bg-slate-200 peer-focus:outline-none rounded-full peer dark:bg-slate-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[4px] after:left-[4px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-red-500"></div>
                                    <span class="ml-4 text-sm font-extrabold ${data.isLocked ? 'text-red-500' : 'text-green-500'} tracking-wide">${data.isLocked ? 'LOCKED' : 'ACTIVE'}</span>
                                </label>
                            </div>
                        </div>

                        <div class="grid grid-cols-1 lg:grid-cols-2 gap-10">
                            <!-- Left Column: Branding -->
                            <div class="space-y-6">
                                <h4 class="font-bold text-slate-700 dark:text-slate-300 flex items-center gap-2">
                                    <i class="fas fa-palette text-blue-500"></i> Visual Branding
                                </h4>
                                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                    <div class="space-y-1.5">
                                        <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">Theme Color</label>
                                        <div class="flex items-center gap-3">
                                            <input type="color" name="primaryColor" value="${data.primaryColor || '#3b82f6'}" class="w-12 h-12 rounded-xl cursor-pointer border-none p-0 bg-transparent">
                                            <input type="text" value="${data.primaryColor || '#3b82f6'}" readonly class="theme-input !bg-slate-50 !border-none font-mono text-sm">
                                        </div>
                                    </div>
                                    <div class="space-y-1.5">
                                        <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">Logo URL</label>
                                        <input type="text" name="logoUrl" value="${data.logoUrl || ''}" placeholder="https://..." class="theme-input">
                                    </div>
                                    <div class="space-y-1.5">
                                        <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">Font Family</label>
                                        <select name="fontFamily" class="theme-input appearance-none">
                                            <option value="Inter, sans-serif" ${data.fontFamily === 'Inter, sans-serif' ? 'selected' : ''}>Inter (Modern)</option>
                                            <option value="'Calibri', 'Segoe UI', sans-serif" ${data.fontFamily === "'Calibri', 'Segoe UI', sans-serif" ? 'selected' : ''}>Calibri (Office)</option>
                                            <option value="'Roboto', sans-serif" ${data.fontFamily === "'Roboto', sans-serif" ? 'selected' : ''}>Roboto</option>
                                            <option value="'Outfit', sans-serif" ${data.fontFamily === "'Outfit', sans-serif" ? 'selected' : ''}>Outfit (Premium)</option>
                                        </select>
                                    </div>
                                </div>
                                <div class="space-y-1.5">
                                    <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">Background URL</label>
                                    <div class="flex flex-col gap-3">
                                        <input type="text" name="backgroundUrl" id="background-url-input" value="${data.backgroundUrl || ''}" placeholder="https://..." class="theme-input">
                                    </div>
                                </div>
                                <div class="space-y-1.5">
                                    <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">Welcome Headline</label>
                                    <input type="text" name="companyPrompt" value="${data.companyPrompt || 'Join our team!'}" class="theme-input">
                                </div>
                            </div>

                            <!-- Right Column: Visibility & Content -->
                            <div class="space-y-6">
                                <h4 class="font-bold text-slate-700 dark:text-slate-300 flex items-center gap-2">
                                    <i class="fas fa-filter text-blue-500"></i> Exposure & Content
                                </h4>
                                
                                <div class="space-y-3">
                                    <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">About the Company (Intro text)</label>
                                    <textarea name="aboutCompany" class="theme-input min-h-[100px] text-sm leading-relaxed" placeholder="Share a few lines about your culture and mission...">${data.aboutCompany || ''}</textarea>
                                </div>

                                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                    <div class="space-y-1.5">
                                        <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">Support Email</label>
                                        <input type="email" name="supportEmail" value="${data.supportEmail || ''}" placeholder="careers@brand.com" class="theme-input">
                                    </div>
                                    <div class="space-y-1.5">
                                        <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">Support Phone</label>
                                        <input type="text" name="supportPhone" value="${data.supportPhone || ''}" placeholder="+91..." class="theme-input">
                                    </div>
                                </div>

                                <!-- Social Links -->
                                <div class="space-y-3">
                                    <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">Social Footprint</label>
                                    <div class="space-y-2">
                                        <div class="relative">
                                            <i class="fab fa-linkedin absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"></i>
                                            <input type="text" name="socialLinkedin" value="${data.socialLinkedin || ''}" placeholder="LinkedIn URL" class="theme-input !pl-10">
                                        </div>
                                    </div>
                                </div>

                            </div>
                        </div>

                        <!-- Full-Width: Open Companies / Departments / Positions -->
                        <div class="pt-4 border-t border-slate-100 dark:border-slate-800 space-y-4">

                                    <!-- OPEN COMPANIES -->
                                    <div class="space-y-3">
                                        <div class="flex justify-between items-center">
                                            <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">Open Companies</label>
                                            <div class="flex gap-2">
                                                <button type="button" id="btn-company-all" class="text-[9px] font-bold text-blue-600 hover:underline px-2 py-1 rounded bg-blue-50">Select All</button>
                                                <button type="button" id="btn-company-clear" class="text-[9px] font-bold text-slate-500 hover:underline px-2 py-1 rounded bg-slate-100">Clear All</button>
                                            </div>
                                        </div>
                                        <div id="portal-company-checks" class="flex flex-wrap gap-2 p-4 bg-slate-50 dark:bg-slate-800/40 rounded-2xl border border-dashed border-slate-200 dark:border-slate-700 min-h-[60px]">
                                            ${allCompanies.map(c => `
                                                <label class="flex items-center gap-2.5 bg-white dark:bg-slate-800 px-3.5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 cursor-pointer hover:border-purple-300 hover:bg-purple-50/30 transition-all select-none">
                                                    <input type="checkbox" name="openCompanies" value="${c.id}" ${(data.openCompanies || []).includes(c.id) ? 'checked' : ''} class="w-4 h-4 rounded border-slate-300 text-purple-600 focus:ring-purple-500 transition-all">
                                                    <span class="text-xs font-semibold text-slate-700 dark:text-slate-300">${c.name}</span>
                                                </label>
                                            `).join('')}
                                            ${allCompanies.length === 0 ? '<p class="text-[10px] text-slate-400 py-2">No companies found</p>' : ''}
                                        </div>
                                    </div>

                                    <!-- OPEN DEPARTMENTS -->
                                    <div class="space-y-3">
                                        <div class="flex justify-between items-center">
                                            <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">Open Departments</label>
                                            <div class="flex items-center gap-3">
                                                <span id="dept-filter-hint" class="text-[9px] font-bold text-purple-500/60 uppercase tracking-tight"></span>
                                                <div class="flex gap-2">
                                                    <button type="button" id="btn-dept-all" class="text-[9px] font-bold text-blue-600 hover:underline px-2 py-1 rounded bg-blue-50">Select All</button>
                                                    <button type="button" id="btn-dept-clear" class="text-[9px] font-bold text-slate-500 hover:underline px-2 py-1 rounded bg-slate-100">Clear All</button>
                                                </div>
                                            </div>
                                        </div>
                                        <div id="portal-dept-checks" class="flex flex-wrap gap-2 p-4 bg-slate-50 dark:bg-slate-800/40 rounded-2xl border border-dashed border-slate-200 dark:border-slate-700 min-h-[60px]">
                                            <!-- Content updated by JS -->
                                        </div>
                                    </div>

                                    <!-- OPEN POSITIONS -->
                                    <div class="space-y-3">
                                        <div class="flex justify-between items-center">
                                            <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">Open Positions</label>
                                            <div class="flex items-center gap-3">
                                                <span id="pos-filter-hint" class="text-[9px] font-bold text-blue-500/60 uppercase tracking-tight"></span>
                                                <div class="flex gap-2">
                                                    <button type="button" id="btn-pos-all" class="text-[9px] font-bold text-blue-600 hover:underline px-2 py-1 rounded bg-blue-50">Select All</button>
                                                    <button type="button" id="btn-pos-clear" class="text-[9px] font-bold text-slate-500 hover:underline px-2 py-1 rounded bg-slate-100">Clear All</button>
                                                </div>
                                            </div>
                                        </div>
                                        <div id="portal-pos-checks" class="max-h-[180px] overflow-y-auto flex flex-wrap gap-2 p-4 bg-slate-50 dark:bg-slate-800/40 rounded-2xl border border-dashed border-slate-200 dark:border-slate-700">
                                            <!-- Content updated by JS -->
                                        </div>
                                    </div>
                        </div>

                         <!-- Wizard & Validation -->
                        <div class="space-y-6 mt-8 pt-8 border-t border-slate-100 dark:border-slate-800">
                          <div>
                            <h4 class="font-bold text-slate-700 dark:text-slate-300 flex items-center gap-2 mb-1">
                              <i class="fas fa-route text-blue-500"></i> Wizard & Validation
                            </h4>
                            <p class="text-xs text-slate-400">Control which steps appear in the candidate application form and which fields are mandatory.</p>
                          </div>

                          <!-- Steps -->
                          <div class="space-y-2">
                            <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Application Steps</p>
                            <p class="text-[11px] text-slate-400 mb-2">Toggle off any step to hide it from candidates. <span class="font-semibold text-blue-500">Personal Details</span> and <span class="font-semibold text-blue-500">Review & Submit</span> are always shown.</p>
                            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                              ${(data.steps || []).map(s => `
                                <label data-portal-step-row data-step-id="${s.id}"
                                       class="flex items-center gap-3 px-4 py-3 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 cursor-pointer hover:border-blue-300 hover:bg-blue-50/20 transition-all group select-none">
                                  <div class="w-8 h-8 rounded-xl bg-blue-50 dark:bg-blue-900/30 flex items-center justify-center shrink-0">
                                    <i class="fas ${s.icon || 'fa-circle-dot'} text-blue-500 text-sm"></i>
                                  </div>
                                  <div class="flex-1 min-w-0">
                                    <div class="text-xs font-bold text-slate-700 dark:text-slate-200 truncate">${s.label}</div>
                                    <div class="text-[10px] text-slate-400 truncate mt-0.5">${s.desc || ''}</div>
                                  </div>
                                  <div class="relative shrink-0">
                                    <input type="checkbox" name="stepEnabled-${s.id}" ${s.enabled ? 'checked' : ''}
                                           class="sr-only peer">
                                    <div class="w-9 h-5 bg-slate-200 peer-checked:bg-blue-500 rounded-full transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-4"></div>
                                  </div>
                                </label>
                              `).join('')}
                            </div>
                          </div>

                          <!-- Required Fields -->
                          <div class="space-y-2">
                            <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Mandatory Fields</p>
                            <p class="text-[11px] text-slate-400 mb-2">Checked fields will block form submission if left empty by the candidate.</p>
                            <div class="flex flex-wrap gap-3">
                              ${[
                { id: 'phone', label: 'Phone (WhatsApp)', icon: 'fa-phone', desc: 'Required for WhatsApp outreach' },
                { id: 'currentCTC', label: 'Current CTC', icon: 'fa-indian-rupee-sign', desc: 'Present salary' },
                { id: 'expectedCTC', label: 'Expected CTC', icon: 'fa-arrow-trend-up', desc: 'Salary expectation' },
                { id: 'noticePeriod', label: 'Notice Period', icon: 'fa-calendar-days', desc: 'Days to join' }
            ].map(f => `
                                <label data-portal-field-toggle data-field-id="${f.id}"
                                       class="flex items-center gap-2.5 px-4 py-2.5 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 cursor-pointer hover:border-blue-300 hover:bg-blue-50/20 transition-all select-none">
                                  <i class="fas ${f.icon} text-blue-400 text-xs w-3"></i>
                                  <div>
                                    <div class="text-xs font-bold text-slate-700 dark:text-slate-200">${f.label}</div>
                                    <div class="text-[10px] text-slate-400">${f.desc}</div>
                                  </div>
                                  <input type="checkbox" name="fieldRequired-${f.id}" ${(data.fields?.[f.id]?.required) ? 'checked' : ''} class="w-4 h-4 ml-1 rounded accent-blue-600">
                                </label>
                              `).join('')}
                            </div>
                          </div>
                        </div>

                        <div class="pt-6 border-t border-slate-100 dark:border-slate-800">
                            <button type="submit" class="w-full bg-blue-600 hover:bg-blue-700 text-white py-4 rounded-2xl font-bold shadow-xl shadow-blue-600/20 transition-all active:scale-[0.98] flex items-center justify-center gap-3">
                                <i class="fas fa-save shadow-sm"></i>
                                Save & Synchronize Public Portal
                            </button>
                        </div>
                    </div>
                </form>`;

        // ===== Cascaded Filtering: Company → Department → Position =====
        const companyContainer = document.getElementById('portal-company-checks');
        const deptContainer = document.getElementById('portal-dept-checks');
        const posContainer = document.getElementById('portal-pos-checks');
        const deptHint = document.getElementById('dept-filter-hint');
        const posHint = document.getElementById('pos-filter-hint');

        // Master selection sets (persisted across re-renders)
        const selectedCompanyIds = new Set(data.openCompanies || []);
        const selectedDeptNames = new Set(data.openDepartments || []);
        const selectedPositionTitles = new Set(data.openPositions || []);

        const renderDepts = () => {
            // Save current dept selections from DOM first
            deptContainer.querySelectorAll('input[name="openDepartments"]').forEach(i => {
                if (i.checked) selectedDeptNames.add(i.value);
                else selectedDeptNames.delete(i.value);
            });

            const selCompanies = Array.from(selectedCompanyIds);
            let filteredDepts = [];
            if (selCompanies.length === 0) {
                filteredDepts = allDepts;
                if (deptHint) deptHint.innerText = '';
            } else {
                // Jobs belonging to selected companies
                const jobsInCompanies = cachedJobs.filter(j => selCompanies.includes(j.companyId));
                filteredDepts = [...new Set(jobsInCompanies.map(j => j.department).filter(Boolean))].sort();
                if (deptHint) deptHint.innerText = `Filtered for ${selCompanies.length} Co.`;
            }

            if (filteredDepts.length === 0) {
                deptContainer.innerHTML = '<p class="text-[10px] text-slate-400 py-2 w-full text-center">No departments for selected companies</p>';
            } else {
                deptContainer.innerHTML = filteredDepts.map(d => `
                            <label class="flex items-center gap-2.5 bg-white dark:bg-slate-800 px-3.5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 cursor-pointer hover:border-blue-300 hover:bg-blue-50/30 transition-all select-none animate-in fade-in zoom-in duration-200">
                                <input type="checkbox" name="openDepartments" value="${d}" ${selectedDeptNames.has(d) ? 'checked' : ''} class="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 transition-all">
                                <span class="text-xs font-semibold text-slate-700 dark:text-slate-300">${d}</span>
                            </label>
                        `).join('');
            }

            // Re-attach dept change listeners after re-render
            deptContainer.querySelectorAll('input[name="openDepartments"]').forEach(i => i.addEventListener('change', () => {
                if (i.checked) selectedDeptNames.add(i.value); else selectedDeptNames.delete(i.value);
                renderPositions();
            }));

            renderPositions();
        };

        const renderPositions = () => {
            // Save current position selections from DOM first
            posContainer.querySelectorAll('input[name="openPositions"]').forEach(i => {
                if (i.checked) selectedPositionTitles.add(i.value);
                else selectedPositionTitles.delete(i.value);
            });

            const selCompanies = Array.from(selectedCompanyIds);
            const selDepts = Array.from(selectedDeptNames);

            let baseJobs = cachedJobs;
            if (selCompanies.length > 0) baseJobs = baseJobs.filter(j => selCompanies.includes(j.companyId));
            if (selDepts.length > 0) baseJobs = baseJobs.filter(j => selDepts.includes(j.department));

            const filteredPositions = [...new Set(baseJobs.map(j => j.title).filter(Boolean))].sort();

            let hintParts = [];
            if (selCompanies.length > 0) hintParts.push(`${selCompanies.length} Co.`);
            if (selDepts.length > 0) hintParts.push(`${selDepts.length} Dept(s)`);
            if (posHint) posHint.innerText = hintParts.length > 0 ? `Filtered for ${hintParts.join(', ')}` : 'Showing all roles';

            if (filteredPositions.length === 0) {
                posContainer.innerHTML = '<p class="text-[10px] text-slate-400 py-2 w-full text-center">No matching positions found</p>';
            } else {
                posContainer.innerHTML = filteredPositions.map(p => `
                            <label class="flex items-center gap-2.5 bg-white dark:bg-slate-800 px-3.5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 cursor-pointer hover:border-blue-300 hover:bg-blue-50/30 transition-all select-none animate-in fade-in zoom-in duration-200">
                                <input type="checkbox" name="openPositions" value="${p}" ${selectedPositionTitles.has(p) ? 'checked' : ''} class="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 transition-all">
                                <span class="text-xs font-semibold text-slate-700 dark:text-slate-300">${p}</span>
                            </label>
                        `).join('');
            }

            // Track position changes
            posContainer.querySelectorAll('input[name="openPositions"]').forEach(i => i.addEventListener('change', () => {
                if (i.checked) selectedPositionTitles.add(i.value); else selectedPositionTitles.delete(i.value);
            }));
        };

        // Company checkbox change listeners
        companyContainer.querySelectorAll('input[name="openCompanies"]').forEach(i => i.addEventListener('change', () => {
            if (i.checked) selectedCompanyIds.add(i.value); else selectedCompanyIds.delete(i.value);
            renderDepts();
        }));

        // Bulk: Companies
        document.getElementById('btn-company-all')?.addEventListener('click', () => {
            companyContainer.querySelectorAll('input[name="openCompanies"]').forEach(i => { i.checked = true; selectedCompanyIds.add(i.value); });
            renderDepts();
        });
        document.getElementById('btn-company-clear')?.addEventListener('click', () => {
            companyContainer.querySelectorAll('input[name="openCompanies"]').forEach(i => { i.checked = false; selectedCompanyIds.delete(i.value); });
            renderDepts();
        });

        // Bulk: Departments
        document.getElementById('btn-dept-all')?.addEventListener('click', () => {
            deptContainer.querySelectorAll('input[name="openDepartments"]').forEach(i => { i.checked = true; selectedDeptNames.add(i.value); });
            renderPositions();
        });
        document.getElementById('btn-dept-clear')?.addEventListener('click', () => {
            deptContainer.querySelectorAll('input[name="openDepartments"]').forEach(i => { i.checked = false; selectedDeptNames.delete(i.value); });
            renderPositions();
        });

        // Bulk: Positions
        document.getElementById('btn-pos-all')?.addEventListener('click', () => {
            posContainer.querySelectorAll('input[name="openPositions"]').forEach(i => { i.checked = true; selectedPositionTitles.add(i.value); });
        });
        document.getElementById('btn-pos-clear')?.addEventListener('click', () => {
            posContainer.querySelectorAll('input[name="openPositions"]').forEach(i => { i.checked = false; selectedPositionTitles.delete(i.value); });
        });

        // Initial render
        renderDepts();

        document.getElementById('form-portal-settings').onsubmit = async (e) => {
            e.preventDefault();
            const fd = new FormData(e.target);

            const openComps = Array.from(selectedCompanyIds);

            const openDepts = [];
            e.target.querySelectorAll('input[name="openDepartments"]:checked').forEach(i => openDepts.push(i.value));

            const openPosts = Array.from(selectedPositionTitles);

            const stepsConfig = [];
            e.target.querySelectorAll('[data-portal-step-row]').forEach(row => {
                const id = row.getAttribute('data-step-id');
                const enabled = row.querySelector('input[type="checkbox"]').checked;
                const existing = (data.steps || []).find(s => s.id === id) || { id, label: id, enabled: true };
                stepsConfig.push({ id, label: existing.label, enabled });
            });
            const fieldsConfig = {};
            ['phone', 'currentCTC', 'expectedCTC', 'noticePeriod'].forEach(f => {
                const checked = e.target.querySelector(`input[name="fieldRequired-${f}"]`)?.checked || false;
                fieldsConfig[f] = { required: checked };
            });

            const s = {
                primaryColor: fd.get('primaryColor'),
                companyPrompt: fd.get('companyPrompt'),
                logoUrl: fd.get('logoUrl'),
                backgroundUrl: fd.get('backgroundUrl'),
                fontFamily: fd.get('fontFamily'),
                // UX fields removed as per request
                aboutCompany: fd.get('aboutCompany'),
                supportEmail: fd.get('supportEmail'),
                supportPhone: fd.get('supportPhone'),
                socialLinkedin: fd.get('socialLinkedin'),
                // Social links removed as per request
                isLocked: e.target.querySelector('input[name="isLocked"]').checked,
                openCompanies: openComps,
                openDepartments: openDepts,
                openPositions: openPosts,
                steps: stepsConfig,
                fields: fieldsConfig,
                updatedAt: serverTimestamp()
            };

            try {
                await setDoc(doc(db, "settings", "publicPortal"), s);
                showToast("Portal Synchronized Successfully");
                loadPortalSettings();
            } catch (e) {
                console.error("Portal Save Error:", e);
                showError("Permission Denied: Ensure Firestore allow writing to 'settings/publicPortal'");
            }
        };
    } catch (e) {
        console.error("Portal Load Error:", e);
        showError("Load failed");
    }
};

// --- POLYMORPHIC PROFILE VIEW LOGIC ---
window.openProfileView = (type, title, icon, candidateId) => {
    const modal = document.getElementById('modal-profile-view');
    const content = document.getElementById('profile-view-content');
    if (!modal || !content) return;

    let navHtml = '';
    if (candidateId && currentInboxQueue.length > 1) {
        const idx = currentInboxQueue.findIndex(c => c.id === candidateId);
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

    // Set Header with Icon and Title
    content.innerHTML = `
                <div class="profile-header-gradient">
                    <div class="profile-avatar-large">
                        <i class="fas ${icon}"></i>
                    </div>
                </div>
                <div class="profile-content-area animate-in fade-in slide-in-from-bottom-4 duration-500">
                    <div class="flex justify-between items-start mb-8">
                        <div>
                            <h2 class="text-3xl font-extrabold text-slate-800 dark:text-white tracking-tight">${title}</h2>
                            <p class="text-slate-500 dark:text-slate-400 font-medium">${type}</p>
                        </div>
                        <div class="flex items-center gap-6">
                            ${navHtml}
                            <div id="profile-status-badge"></div>
                        </div>
                    </div>
                    <div id="profile-detailed-grid" class="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <!-- Content Injected by Type-Specific Renderers -->
                    </div>
                </div>
            `;
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
    const grid = document.getElementById('profile-detailed-grid');
    const badgeContainer = document.getElementById('profile-status-badge');

    if (badgeContainer) {
        const stageClass = c.stage === 'REJECTED' ? 'badge-red' : (c.stage === 'HIRED' ? 'badge-green' : 'badge-blue');
        badgeContainer.innerHTML = `<span class="badge ${stageClass} scale-110 px-4 py-1.5 shadow-sm">${c.stage || 'Sourced'}</span>`;
    }

    grid.innerHTML = `
                ${c.resumeUrl ? `
                <div class="profile-data-card md:col-span-2 border-dashed border-blue-200 bg-blue-50/20">
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-4">
                            <div class="w-12 h-12 rounded-xl bg-blue-100 flex items-center justify-center text-blue-600">
                                <i class="fas fa-file-pdf text-xl"></i>
                            </div>
                            <div>
                                <p class="text-sm font-bold text-slate-800 dark:text-slate-200">Curriculum Vitae</p>
                                <p class="text-xs text-slate-500">Applicant Resume is available for preview</p>
                            </div>
                        </div>
                        <button onclick="previewResume('${c.resumeUrl}')" class="px-6 py-2 bg-blue-600 text-white rounded-xl text-xs font-bold shadow-lg shadow-blue-500/30 hover:scale-105 transition-transform">Preview Resume</button>
                    </div>
                </div>` : ''}
                <div class="profile-data-card">
                    <p class="profile-label">Contact Information</p>
                    <div class="space-y-3 mt-2">
                        <div class="flex items-center gap-3 text-sm">
                            <i class="fas fa-envelope text-blue-500 w-4"></i>
                            <span class="text-slate-700 dark:text-slate-300">${c.email}</span>
                        </div>
                        <div class="flex items-center gap-3 text-sm">
                            <i class="fas fa-phone text-emerald-500 w-4"></i>
                            <span class="text-slate-700 dark:text-slate-300">${c.phone}</span>
                        </div>
                        <div class="flex items-center gap-3 text-sm">
                            <i class="fas fa-map-marker-alt text-red-400 w-4"></i>
                            <span class="text-slate-700 dark:text-slate-300">${c.address || 'No address provided'}</span>
                        </div>
                    </div>
                </div>
                <div class="profile-data-card">
                    <p class="profile-label">Professional Summary</p>
                    <div class="grid grid-cols-2 gap-4 mt-2">
                        <div>
                            <p class="text-[10px] text-slate-400 uppercase">Experience</p>
                            <p class="profile-value">${c.experience || 0} Years</p>
                        </div>
                        <div>
                            <p class="text-[10px] text-slate-400 uppercase">Qualification</p>
                            <p class="profile-value">${c.qualification || 'N/A'}</p>
                        </div>
                        <div>
                            <p class="text-[10px] text-slate-400 uppercase">Current Co.</p>
                            <p class="profile-value">${c.currentCompany || 'N/A'}</p>
                        </div>
                        <div>
                            <p class="text-[10px] text-slate-400 uppercase">Source</p>
                            <p class="profile-value">${c.source || 'Direct'}</p>
                        </div>
                    </div>
                </div>
                <div class="profile-data-card md:col-span-2">
                    <p class="profile-label">Compensation Details</p>
                    <div class="flex flex-wrap gap-8 mt-2">
                        <div>
                            <p class="text-[10px] text-slate-400 uppercase">Current CTC</p>
                            <p class="profile-value text-slate-600">₹${(c.currentCTC || 0).toLocaleString()}/mo</p>
                        </div>
                        <div>
                            <p class="text-[10px] text-slate-400 uppercase">Expected CTC</p>
                            <p class="profile-value text-blue-600">₹${(c.expectedCTC || 0).toLocaleString()}/mo</p>
                        </div>
                         <div>
                            <p class="text-[10px] text-slate-400 uppercase">Notice Period</p>
                            <p class="profile-value">${c.noticePeriod || 0} Days</p>
                        </div>
                    </div>
                </div>
                <div class="profile-data-card md:col-span-2 border-dashed border-indigo-200 bg-indigo-50/20">
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-4">
                            <div class="w-12 h-12 rounded-xl bg-indigo-100 flex items-center justify-center text-indigo-600">
                                <i class="fas fa-share-nodes text-xl"></i>
                            </div>
                            <div>
                                <p class="text-sm font-bold text-slate-800 dark:text-slate-200">Share Profile</p>
                                <p class="text-xs text-slate-500">Generate a read-only link for hiring managers</p>
                            </div>
                        </div>
                        <button onclick="generateShareLink('${c.id}')" class="px-6 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold shadow-lg shadow-indigo-500/30 hover:scale-105 transition-transform flex items-center gap-2">
                            <i class="fas fa-link"></i> Copy Link
                        </button>
                    </div>
                </div>
            `;
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

window.renderOrganogram = () => {
    const container = document.getElementById('organogram-container');
    if (!container) return;

    const companySelect = document.getElementById('organogram-company-filter');
    const selectedCompanyIdBeforeRender = companySelect ? companySelect.value : 'all';

    // Refresh company select options to prevent duplicates
    if (companySelect) {
        // Remove 'All Companies' and only show individual created companies
        companySelect.innerHTML = '';
        if (cachedCompanies.length > 0) {
            cachedCompanies.forEach((c, idx) => {
                const opt = document.createElement('option');
                opt.value = c.id;
                opt.innerText = c.name || 'Unnamed Company';
                if (c.id === selectedCompanyIdBeforeRender || (selectedCompanyIdBeforeRender === 'all' && idx === 0)) {
                    opt.selected = true;
                }
                companySelect.appendChild(opt);
            });
        }
    }

    // Default to the first company if "all" was selected but no longer exists
    const selectedCompanyId = (companySelect && companySelect.value) ? companySelect.value : (cachedCompanies.length > 0 ? cachedCompanies[0].id : null);

    if (!selectedCompanyId) {
        container.innerHTML = `<div class="py-20 text-center text-slate-400 font-medium italic">Please select a company to view its organogram.</div>`;
        return;
    }

    // Determine which companies to render (always specific company now)
    const companiesToRender = cachedCompanies.filter(c => c.id === selectedCompanyId);

    const hired = cachedCandidates.filter(c => c.stage === 'Hired');

    if (companiesToRender.length === 0) {
        container.innerHTML = `<div class="py-20 text-center text-slate-400">No company data available.</div>`;
        return;
    }

    // Build overall HTML
    let html = `<div class="flex flex-col items-center gap-16 w-full py-4 overflow-visible">`;

    // We can render each company as a separate root tree, or if just one, a single root.
    companiesToRender.forEach(company => {
        // Find jobs for this company
        const companyJobs = cachedJobs.filter(j => j.companyId === company.id);
        const depts = [...new Set(companyJobs.map(j => j.department).filter(Boolean))];

        // Find hired candidates for this company
        const companyJobIds = new Set(companyJobs.map(j => j.id));
        const companyHired = hired.filter(c => companyJobIds.has(c.jobId));

        if (depts.length === 0 && companyHired.length === 0) {
            // Optional: skip empty companies if viewing 'all'
            if (selectedCompanyId === 'all' && companiesToRender.length > 1) return;
        }

        const hierarchy = {};
        depts.forEach(d => {
            hierarchy[d] = {};
            const jobsInDept = companyJobs.filter(j => j.department === d);
            jobsInDept.forEach(j => {
                hierarchy[d][j.title] = companyHired.filter(c => c.jobId === j.id);
            });
        });

        const rootName = company.name || "Unnamed Company";

        html += `
            <div class="flex flex-col items-start lg:items-center w-full mb-16 relative min-w-max px-12 mx-auto">
                <!-- Root node (Company) -->
                <div class="flex flex-col items-center group relative z-10">
                    <div class="px-8 py-4 bg-blue-600 text-white rounded-2xl shadow-xl font-bold text-lg border-2 border-blue-400/50 group-hover:scale-105 transition-transform text-center min-w-[200px]">
                        ${rootName}
                    </div>
                </div>

                ${depts.length > 0 ? `
                <!-- Connecting Line from Company down to Horizontal Line -->
                <div class="w-px h-8 bg-blue-300 dark:bg-slate-600"></div>

                <!-- Departments Level -->
                <div class="flex flex-nowrap justify-start lg:justify-center items-start w-full mt-0 min-w-max px-12 mx-auto">
                    
                    ${Object.keys(hierarchy).map((dept, index, array) => {
            // Logic for the horizontal connecting top border
            let borderClasses = "border-t-2 border-blue-300 dark:border-slate-600 ";
            if (array.length === 1) borderClasses = "border-t-0 "; // Only 1, no horizontal line needed
            else if (index === 0) borderClasses += "rounded-tl-none border-l-0 w-1/2 ml-auto "; // First item
            else if (index === array.length - 1) borderClasses += "rounded-tr-none border-r-0 w-1/2 mr-auto "; // Last item
            else borderClasses += "w-full "; // Middle items

            return `
                        <div class="flex flex-col items-center relative z-10 flex-1 min-w-[250px] w-full max-w-[300px]">
                            
                            <!-- Top Horizontal Line Section -->
                            <div class="${borderClasses} h-8 flex justify-center w-full">
                                <!-- Top Center Vertical Drop Down Line -->
                                <div class="w-px h-8 bg-blue-300 dark:bg-slate-600"></div>
                            </div>
                            
                            <!-- Dept Node -->
                            <div class="px-6 py-3 bg-slate-800 dark:bg-slate-700 text-white rounded-xl shadow-lg font-bold text-sm mb-6 border border-slate-600 text-center w-[90%] max-w-[250px] truncate relative z-10 m-0">
                                ${dept}
                            </div>
                            
                            <div class="space-y-4 w-full flex flex-col items-center relative mt-6">
                                ${Object.keys(hierarchy[dept]).map((role, idx) => {
                const cands = hierarchy[dept][role];
                return `
                                        <div class="flex flex-col items-center w-full relative">
                                            <!-- Vertical line from Dept/Previous Role to Role -->
                                            ${idx === 0
                        ? `<div class="w-px h-6 bg-blue-300 dark:bg-slate-600 absolute top-[-24px]"></div>`
                        : `<div class="w-px h-4 bg-blue-300 dark:bg-slate-600 absolute top-[-16px]"></div>`
                    }
                                            
                                            <!-- Role Node -->
                                            <div class="px-4 py-3 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-xl w-[90%] max-w-[250px] text-center shadow-sm hover:shadow-md transition-shadow relative z-10">
                                                <div class="text-[11px] uppercase font-bold text-blue-600 dark:text-blue-400 mb-2 border-b border-blue-100 dark:border-blue-800/50 pb-1">${role}</div>
                                                <div class="flex flex-col gap-1.5 pt-1">
                                                    ${cands.length > 0 ? cands.map(c => `
                                                        <div class="text-[11px] font-semibold text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 py-1.5 px-2 rounded-lg border border-slate-200 dark:border-slate-700 shadow flex items-center justify-center gap-2 hover:bg-slate-50 dark:hover:bg-slate-700/50 cursor-pointer transition-colors" onclick="showCandidateProfile('${c.id}')">
                                                            <i class="fas fa-user-circle text-blue-500 text-sm"></i> 
                                                            <span class="truncate max-w-[150px]">${c.name}</span>
                                                        </div>
                                                    `).join('') : '<div class="text-[10px] text-slate-400 italic py-1 bg-slate-50 dark:bg-slate-800/30 rounded border border-dashed border-slate-200 dark:border-slate-700">Vacant Position</div>'}
                                                </div>
                                            </div>
                                        </div>
                                    `;
            }).join('')}
                            </div>
                        </div>
                    `;
        }).join('')}
                </div>
                ` : `<div class="mt-4 text-slate-400 italic text-sm">No departments or jobs defined</div>`}
            </div>
        `;
    });

    html += `</div>`;

    if (html === `<div class="flex flex-col items-center gap-16 w-full py-4 overflow-visible"></div>`) {
        html = `<div class="py-20 text-center text-slate-400">No organizational data available yet. Please ensure you have jobs assigned to companies and hired candidates.</div>`;
    }

    container.innerHTML = html;

    // SYNC: Ensure the custom dropdown UI reflects the choices after repopulating the native select
    try { initCustomSelects(); } catch (e) { console.warn('Organogram dropdown sync failed', e); }
};

// Export to PDF function
window.exportOrganogramPDF = () => {
    const element = document.getElementById('organogram-container');
    if (!element) return;

    // Temporarily adjust layout for capture
    const originalClasses = element.className;
    element.classList.remove('overflow-x-auto');
    element.style.width = 'max-content';
    element.style.padding = '40px';
    element.style.backgroundColor = document.documentElement.classList.contains('dark') ? '#0f172a' : '#ffffff';

    // Calculate dimensions for ONE page fit
    // We use px as the unit to match the element's scroll dimensions exactly
    const widthPx = element.scrollWidth + 80;
    const heightPx = element.scrollHeight + 80;

    // Scale for high quality (2x internal res)
    const scale = 2;

    const opt = {
        margin: 0,
        filename: 'Corporate_Organogram.pdf',
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: {
            scale: scale,
            useCORS: true,
            logging: false,
            width: widthPx,
            windowWidth: widthPx
        },
        // IMPORTANT: Use [width, height] in px to force the PDF into exactly one page
        jsPDF: { unit: 'px', format: [widthPx, heightPx], orientation: widthPx > heightPx ? 'l' : 'p' }
    };

    showToast('Preparing one-page PDF...', 'info');

    html2pdf().set(opt).from(element).save().then(() => {
        // Restore styling
        element.className = originalClasses;
        element.style.width = '';
        element.style.padding = '';
        element.style.backgroundColor = '';
        showToast('One-page PDF Exported Successfully!', 'success');
    }).catch(err => {
        console.error('PDF Export Error:', err);
        showToast('Export failed. Check console.', 'error');
        element.className = originalClasses;
        element.style.width = '';
        element.style.padding = '';
        element.style.backgroundColor = '';
    });
};

let currentInboxJobId = null;
let currentInboxFilter = 'all';

window.renderTalentPool = () => {
    const overviewLevel = document.getElementById('talentpool-overview-level');
    const inboxLevel = document.getElementById('talentpool-inbox-level');
    const jobList = document.getElementById('talentpool-job-list');
    if (!jobList) return;

    // Ensure we are in overview level
    overviewLevel.classList.remove('hidden');
    inboxLevel.classList.add('hidden');

    const searchTerm = document.getElementById('talentpool-search')?.value.toLowerCase() || '';
    const statusFilter = document.getElementById('talentpool-filter-status')?.value || 'all';

    const candidates = cachedCandidates.filter(c => c.inTalentPool === true);

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
        const shortlistedCount = cachedCandidates.filter(c => c.jobId === j.id && !c.inTalentPool && c.stage !== 'REJECTED').length;
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

window.viewJobInbox = (jobId) => {
    currentInboxJobId = jobId;
    currentInboxFilter = 'all';

    // Switch to talentpool section if not already there
    showSection('talentpool');

    const searchInput = document.getElementById('inbox-search');
    if (searchInput) searchInput.value = '';

    const job = cachedJobs.find(j => j.id === jobId);
    if (!job) return;

    document.getElementById('talentpool-overview-level').classList.add('hidden');
    document.getElementById('talentpool-inbox-level').classList.remove('hidden');

    document.getElementById('inbox-job-title').innerText = job.title;
    document.getElementById('inbox-job-location').innerHTML = `<i class="fas fa-map-marker-alt mr-1"></i> ${job.location}`;
    document.getElementById('inbox-job-status').innerText = job.status || 'Active';

    filterInbox('all');
};

window.exitJobInbox = () => {
    document.getElementById('talentpool-inbox-level').classList.add('hidden');
    document.getElementById('talentpool-overview-level').classList.remove('hidden');
    currentInboxJobId = null;
    renderTalentPool();
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
    const listContainer = document.getElementById('inbox-candidate-list');
    if (!listContainer || !currentInboxJobId) return;

    const job = cachedJobs.find(j => j.id === currentInboxJobId);
    let candidates = cachedCandidates.filter(c => c.jobId === currentInboxJobId);
    const searchTerm = document.getElementById('inbox-search')?.value.toLowerCase() || '';

    // Apply Folder Filter
    if (currentInboxFilter === 'all') candidates = candidates.filter(c => c.inTalentPool);
    else if (currentInboxFilter === 'new') candidates = candidates.filter(c => c.inTalentPool && c.isNew);
    else if (currentInboxFilter === 'shortlisted') candidates = candidates.filter(c => !c.inTalentPool && c.stage !== 'REJECTED');
    else if (currentInboxFilter === 'rejected') candidates = candidates.filter(c => c.stage === 'REJECTED');

    // Apply Search Filter
    if (searchTerm) {
        candidates = candidates.filter(c =>
            c.name.toLowerCase().includes(searchTerm) ||
            c.email.toLowerCase().includes(searchTerm) ||
            (c.skills && c.skills.toLowerCase().includes(searchTerm)) ||
            (c.currentDesignation && c.currentDesignation.toLowerCase().includes(searchTerm))
        );
    }

    currentInboxQueue = candidates; // Store for navigation

    // Update Counts (Counts should reflect folder size without search filter for context)
    document.getElementById('count-all').innerText = cachedCandidates.filter(c => c.jobId === currentInboxJobId && c.inTalentPool).length;
    document.getElementById('count-new').innerText = cachedCandidates.filter(c => c.jobId === currentInboxJobId && c.inTalentPool && c.isNew).length;
    document.getElementById('count-shortlisted').innerText = cachedCandidates.filter(c => c.jobId === currentInboxJobId && !c.inTalentPool && c.stage !== 'REJECTED').length;
    document.getElementById('count-rejected').innerText = cachedCandidates.filter(c => c.jobId === currentInboxJobId && c.stage === 'REJECTED').length;

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

    listContainer.innerHTML = candidates.map(c => {
        const score = calculateMatchScore(c, job);
        const skillsArr = (c.skills || '').split(',').map(s => s.trim()).filter(s => s !== '');

        return `
                    <div class="group bg-white dark:bg-slate-800/50 p-5 rounded-2xl border border-slate-100 dark:border-slate-800 hover:border-blue-200 dark:hover:border-blue-900 transition-all flex flex-col md:flex-row gap-5 relative">
                        <div class="absolute top-4 left-3">
                            <input type="checkbox" name="inbox-candidate-check" value="${c.id}" class="w-4 h-4 rounded border-slate-300 text-blue-600 transition-all">
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
                                ${skillsArr.slice(0, 6).map(s => `<span class="px-2 py-0.5 bg-slate-100/50 dark:bg-slate-800 text-slate-500 dark:text-slate-400 rounded text-[10px] border border-slate-200/50 dark:border-slate-700/50 font-medium">${s}</span>`).join('')}
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
                            <button onclick="showCandidateProfile('${c.id}')" class="flex-1 md:flex-none px-4 py-2 bg-slate-50 dark:bg-slate-900/50 text-slate-600 dark:text-slate-400 rounded-xl text-xs font-bold hover:bg-slate-100 transition">View</button>
                            <button onclick="moveToPipeline('${c.id}')" class="flex-1 md:flex-none px-4 py-2 bg-blue-600 text-white rounded-xl text-xs font-bold hover:bg-blue-700 transition shadow-lg shadow-blue-500/20">Shortlist</button>
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
        // local update will happen via onSnapshot
    } catch (error) {
        console.error("Error moving to pipeline:", error);
        showToast("Failed to move candidate.", "error");
    }
};

window.bulkInboxAction = async (action) => {
    const selected = Array.from(document.querySelectorAll('input[name="inbox-candidate-check"]:checked')).map(i => i.value);
    if (selected.length === 0) return;

    const isShortlist = action === 'shortlist';
    const updates = {
        inTalentPool: isShortlist ? false : true,
        isNew: false,
        stage: isShortlist ? 'Screening' : 'Rejected',
        updatedAt: serverTimestamp()
    };

    try {
        showToast(`Processing ${selected.length} candidates...`);
        const promises = selected.map(id => updateDoc(doc(db, 'candidates', id), updates));
        await Promise.all(promises);
        showToast(`Bulk ${isShortlist ? 'shortlisted' : 'rejected'} ${selected.length} candidates.`);
        toggleBulkBar();
        // Local cache updates happen via onSnapshot
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
});

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
    if (!cachedCandidates) return;
    const newCount = cachedCandidates.filter(c => c.inTalentPool && c.isNew).length;
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
document.getElementById('form-task').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const taskId = document.getElementById('form-task-id') ? document.getElementById('form-task-id').value : '';

    try {
        if (taskId) {
            await updateDoc(doc(db, "tasks", taskId), {
                title: fd.get('title'),
                priority: fd.get('priority'),
                dueDate: fd.get('dueDate')
            });
            showToast("Task Updated");
        } else {
            await addDoc(collection(db, "tasks"), {
                title: fd.get('title'),
                priority: fd.get('priority'),
                dueDate: fd.get('dueDate'),
                status: 'todo',
                createdAt: serverTimestamp()
            });
            showToast("Task Created");
        }
        closeModal('modal-task');
    } catch (e) { showError("Failed"); }
};



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

// ===================== NOTIFICATION CENTER LOGIC =====================
let dismissedNotifKeys = JSON.parse(localStorage.getItem('dismissedNotifs') || '[]');

function computeNotifications() {
    const notifs = [];
    const todayStr = new Date().toISOString().split('T')[0];
    const now = Date.now();
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

    // 1. Interviews Today
    const todayInterviews = cachedInterviews.filter(i => i.dateTime && i.dateTime.startsWith(todayStr));
    todayInterviews.forEach(i => {
        const cand = cachedCandidates.find(c => c.id === i.candidateId);
        const dt = new Date(i.dateTime);
        const timeStr = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        notifs.push({
            key: `int-today-${i.id}`,
            icon: 'fa-calendar-check',
            color: 'text-orange-500 bg-orange-100 dark:bg-orange-900/30',
            title: `Interview at ${timeStr}`,
            desc: cand ? cand.name : 'Unknown candidate',
            action: () => showSection('interviews'),
            category: 'Interviews Today'
        });
    });

    // 2. Candidates Stuck (same stage for 7+ days)
    cachedCandidates.forEach(c => {
        if (['Hired', 'Rejected', 'Backed Out', 'Not Interested'].includes(c.stage)) return;
        const created = c.updatedAt || c.createdAt;
        if (!created) return;
        const ts = created.seconds ? created.seconds * 1000 : new Date(created).getTime();
        if (now - ts > SEVEN_DAYS) {
            const daysStuck = Math.floor((now - ts) / (24 * 60 * 60 * 1000));
            notifs.push({
                key: `stuck-${c.id}`,
                icon: 'fa-hourglass-half',
                color: 'text-amber-500 bg-amber-100 dark:bg-amber-900/30',
                title: `Stuck for ${daysStuck} days`,
                desc: `${c.name} — ${c.stage}`,
                action: () => { showSection('candidates'); },
                category: 'Attention Needed'
            });
        }
    });

    // 3. Overdue Tasks
    cachedTasks.forEach(t => {
        if ((t.status || 'todo').toLowerCase() === 'done') return;
        if (!t.dueDate) return;
        const due = new Date(t.dueDate);
        if (due < new Date(todayStr)) {
            notifs.push({
                key: `task-overdue-${t.id}`,
                icon: 'fa-clock',
                color: 'text-red-500 bg-red-100 dark:bg-red-900/30',
                title: 'Overdue task',
                desc: t.title,
                action: () => showSection('tasks'),
                category: 'Overdue Tasks'
            });
        }
    });

    // 4. New Applications Today
    const newApps = cachedCandidates.filter(c => {
        if (c.stage !== 'Applied') return false;
        const ts = c.createdAt;
        if (!ts) return false;
        const d = new Date(ts.seconds ? ts.seconds * 1000 : ts);
        return d.toISOString().split('T')[0] === todayStr;
    });
    if (newApps.length > 0) {
        notifs.push({
            key: `new-apps-${todayStr}`,
            icon: 'fa-inbox',
            color: 'text-blue-500 bg-blue-100 dark:bg-blue-900/30',
            title: `${newApps.length} new application${newApps.length > 1 ? 's' : ''} today`,
            desc: newApps.slice(0, 3).map(c => c.name).join(', ') + (newApps.length > 3 ? '...' : ''),
            action: () => showSection('talentpool'),
            category: 'New Applications'
        });
    }

    // 5. Offers Pending Response
    const pendingOffers = cachedOffers.filter(o => !o.status || o.status === 'Pending' || o.status === 'Sent');
    if (pendingOffers.length > 0) {
        notifs.push({
            key: `offers-pending-${todayStr}`,
            icon: 'fa-signature',
            color: 'text-emerald-500 bg-emerald-100 dark:bg-emerald-900/30',
            title: `${pendingOffers.length} offer${pendingOffers.length > 1 ? 's' : ''} awaiting response`,
            desc: 'Review in Offer Management',
            action: () => showSection('offers'),
            category: 'Pending Offers'
        });
    }

    return notifs;
}

function refreshNotificationBadge() {
    const notifs = computeNotifications();
    const unread = notifs.filter(n => !dismissedNotifKeys.includes(n.key));
    const badge = document.getElementById('notif-badge');
    if (badge) {
        if (unread.length > 0) {
            badge.innerText = unread.length > 99 ? '99+' : unread.length;
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    }
}

function renderNotifications() {
    const container = document.getElementById('notification-items');
    if (!container) return;

    const notifs = computeNotifications();
    const unread = notifs.filter(n => !dismissedNotifKeys.includes(n.key));

    if (notifs.length === 0) {
        container.innerHTML = `
            <div class="flex flex-col items-center justify-center py-12 text-slate-400">
                <i class="fas fa-bell-slash text-3xl mb-3 opacity-20"></i>
                <p class="text-sm">All clear — no notifications!</p>
            </div>`;
        return;
    }

    // Group by category
    const groups = {};
    notifs.forEach(n => {
        if (!groups[n.category]) groups[n.category] = [];
        groups[n.category].push(n);
    });

    let html = '';
    Object.keys(groups).forEach(category => {
        html += `<div class="px-4 pt-3 pb-1">
            <p class="text-[10px] font-bold uppercase tracking-widest text-slate-400">${category}</p>
        </div>`;
        groups[category].forEach(n => {
            const isRead = dismissedNotifKeys.includes(n.key);
            html += `
            <div class="flex items-start gap-3 px-4 py-3 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors ${isRead ? 'opacity-50' : ''}"
                 onclick="handleNotifClick('${n.key}', ${groups[category].indexOf(n)}, '${n.category}')">
                <div class="w-9 h-9 rounded-xl ${n.color} flex items-center justify-center flex-shrink-0 mt-0.5">
                    <i class="fas ${n.icon} text-sm"></i>
                </div>
                <div class="flex-1 min-w-0">
                    <p class="text-sm font-semibold ${isRead ? '' : ''}" style="color: var(--text-primary)">${n.title}</p>
                    <p class="text-xs truncate" style="color: var(--text-muted)">${n.desc}</p>
                </div>
                ${!isRead ? '<div class="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0 mt-2"></div>' : ''}
            </div>`;
        });
    });

    container.innerHTML = html;
}

// Store computed notifications globally so click handler can reference them
let _cachedNotifs = [];

window.handleNotifClick = (key, index, category) => {
    // Find and execute the notification action
    const notifs = computeNotifications();
    const notif = notifs.find(n => n.key === key);
    if (notif && notif.action) {
        // Mark as read
        if (!dismissedNotifKeys.includes(key)) {
            dismissedNotifKeys.push(key);
            localStorage.setItem('dismissedNotifs', JSON.stringify(dismissedNotifKeys));
        }
        // Close panel
        document.getElementById('notification-panel').classList.add('hidden');
        // Navigate
        notif.action();
        refreshNotificationBadge();
    }
};

window.toggleNotifications = (e) => {
    e.stopPropagation();
    const panel = document.getElementById('notification-panel');
    const isHidden = panel.classList.contains('hidden');
    // Close profile menu if open
    const profileMenu = document.getElementById('profile-menu');
    if (profileMenu) profileMenu.classList.remove('show');
    if (isHidden) {
        renderNotifications();
        panel.classList.remove('hidden');
    } else {
        panel.classList.add('hidden');
    }
};

window.markAllNotificationsRead = () => {
    const notifs = computeNotifications();
    notifs.forEach(n => {
        if (!dismissedNotifKeys.includes(n.key)) {
            dismissedNotifKeys.push(n.key);
        }
    });
    // Keep only last 200 keys to prevent localStorage bloat
    if (dismissedNotifKeys.length > 200) {
        dismissedNotifKeys = dismissedNotifKeys.slice(-200);
    }
    localStorage.setItem('dismissedNotifs', JSON.stringify(dismissedNotifKeys));
    refreshNotificationBadge();
    renderNotifications();
};

// Close notification panel on outside click
window.addEventListener('click', (e) => {
    const panel = document.getElementById('notification-panel');
    const wrapper = document.getElementById('notification-wrapper');
    if (panel && wrapper && !wrapper.contains(e.target) && !panel.classList.contains('hidden')) {
        panel.classList.add('hidden');
    }
});
