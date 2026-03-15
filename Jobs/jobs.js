import { 
    auth, db, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
    collection, addDoc, getDocs, getDoc, doc, onSnapshot, serverTimestamp, query, where
} from "../firebase_config.js";


// CLOUDINARY CONFIG
const CLOUDINARY_URL = 'https://api.cloudinary.com/v1_1/drz2jldgj/auto/upload';
const CLOUDINARY_PRESET = 'resume_uploads';

// Elements
const authContainer = document.getElementById('auth-container');
const googleLoginBtn = document.getElementById('google-login-btn');
const emailAuthForm = document.getElementById('email-auth-form');
const emailAuthBtn = document.getElementById('email-auth-btn');
const authEmail = document.getElementById('auth-email');
const authPassword = document.getElementById('auth-password');
const authTitle = document.getElementById('auth-title');
const authSubtitle = document.getElementById('auth-subtitle');
const authToggleBtn = document.getElementById('auth-toggle-btn');
const authToggleText = document.getElementById('auth-toggle-text');
const loginError = document.getElementById('login-error');
const logoutBtn = document.getElementById('logout-btn');

const form = document.getElementById('candidate-form');
const formContainer = document.getElementById('form-container');
const successMessage = document.getElementById('success-message');
const submitBtn = document.getElementById('submit-btn');

const candidateNameInput = document.getElementById('candidate-name');
const candidateEmailInput = document.getElementById('candidate-email');
const companySelect = document.getElementById('company-select');
const deptSelect = document.getElementById('dept-select');
const jobSelect = document.getElementById('job-select');
const resumeFileInput = document.getElementById('resumeFile');
const resumeFileLabel = document.getElementById('resumeFileLabel');

let allJobs = [];
let allCompanies = [];
let portalSettings = null;
let authenticatedUser = null;
let authMode = 'login'; // 'login' or 'signup'

// --- Other Qualification Toggle ---
const qualificationSelect = document.getElementById('qualification-select');
const otherQualWrap = document.getElementById('other-qualification-wrap');
const otherQualInput = document.getElementById('other-qualification-input');
if (qualificationSelect && otherQualWrap && otherQualInput) {
    qualificationSelect.addEventListener('change', () => {
        const isOther = qualificationSelect.value === 'Other';
        otherQualWrap.classList.toggle('hidden', !isOther);
        otherQualInput.required = isOther;
        if (!isOther) otherQualInput.value = '';
    });
}

// --- Pincode Auto-fill (India Post API) ---
(function initPincodeAutofill() {
    const pincodeInput = document.querySelector('input[name="addressPincode"]');
    const cityInput = document.querySelector('input[name="addressCity"]');
    const stateSelect = document.querySelector('select[name="addressState"]');
    if (!pincodeInput || !cityInput || !stateSelect) return;

    // Helper: find closest matching <option> in the state select
    function setStateOption(stateName) {
        const opts = Array.from(stateSelect.options);
        const match = opts.find(o => o.text.toLowerCase() === stateName.toLowerCase());
        if (match) {
            stateSelect.value = match.value || match.text;
        }
    }

    let _timeout;
    pincodeInput.addEventListener('input', () => {
        const pin = pincodeInput.value.replace(/\D/g, '');
        clearTimeout(_timeout);

        // Clear hints if incomplete
        if (pin.length < 6) {
            pincodeInput.classList.remove('border-green-400', 'border-red-400');
            return;
        }

        // Debounce 400 ms so we don't fire on every keystroke
        _timeout = setTimeout(async () => {
            pincodeInput.placeholder = 'Looking up…';
            pincodeInput.classList.remove('border-green-400', 'border-red-400');
            try {
                const res = await fetch(`https://api.postalpincode.in/pincode/${pin}`);
                const json = await res.json();
                const record = json?.[0];
                if (record?.Status === 'Success' && record.PostOffice?.length > 0) {
                    const po = record.PostOffice[0];
                    // Only fill if blank (don't override user edits)
                    if (!cityInput.value) cityInput.value = po.District || po.Name || '';
                    setStateOption(po.State || '');
                    pincodeInput.classList.add('border-green-400');
                } else {
                    pincodeInput.classList.add('border-red-400');
                }
            } catch {
                // Silently fail — network issues shouldn't break the form
            } finally {
                pincodeInput.placeholder = 'e.g. 411001';
            }
        }, 400);
    });
})();


// --- WIZARD SETUP ---
const wizardSteps = [
    { id: 'step-personal', label: 'Personal Details' },
    { id: 'step-professional', label: 'Professional Details' },
    { id: 'step-position', label: 'Applied Position' },
    { id: 'step-financials', label: 'CTC & Financials' },
    { id: 'step-resume', label: 'Resume Upload' },
    { id: 'step-review', label: 'Review & Submit' }
];
let currentStepIndex = 0;
const stepEls = wizardSteps.map(s => document.getElementById(s.id));
const stepLabelEl = document.getElementById('wizard-step-label');
const stepHintEl = document.getElementById('wizard-step-hint');
const progressBarEl = document.getElementById('wizard-progress-bar');
const nextBtn = document.getElementById('wizard-next-btn');
const backBtn = document.getElementById('wizard-back-btn');

function showStep(index) {
    currentStepIndex = Math.max(0, Math.min(index, wizardSteps.length - 1));
    stepEls.forEach((el, i) => {
        if (!el) return;
        if (i === currentStepIndex) el.classList.remove('hidden');
        else el.classList.add('hidden');
    });
    const step = wizardSteps[currentStepIndex];
    if (stepLabelEl) stepLabelEl.textContent = `Step ${currentStepIndex + 1} of ${wizardSteps.length} • ${step.label}`;
    if (progressBarEl) {
        const pct = ((currentStepIndex + 1) / wizardSteps.length) * 100;
        progressBarEl.style.width = `${pct}%`;
    }
    if (backBtn) backBtn.disabled = currentStepIndex === 0;
    if (nextBtn && submitBtn) {
        if (currentStepIndex === wizardSteps.length - 1) {
            nextBtn.classList.add('hidden');
            submitBtn.classList.remove('hidden');
        } else {
            nextBtn.classList.remove('hidden');
            submitBtn.classList.add('hidden');
        }
    }
    // Render review when reaching the last step
    if (currentStepIndex === wizardSteps.length - 1) {
        renderReviewStep();
    } else {
        const firstInput = stepEls[currentStepIndex]?.querySelector('input, select, textarea');
        if (firstInput) firstInput.focus();
    }
}

function renderReviewStep() {
    const reviewEl = document.getElementById('step-review');
    if (!reviewEl) return;

    const f = document.getElementById('candidate-form');
    const val = (name) => {
        const el = f ? f.elements[name] : null;
        return el ? (el.value || '').trim() : '';
    };
    const resumeInput = document.getElementById('resumeFile');
    const resumeFileName = resumeInput && resumeInput.files[0] ? resumeInput.files[0].name : '';

    // Helper: selected job title from the live select
    const jobSelEl = document.getElementById('job-select');
    const jobLabel = jobSelEl && jobSelEl.selectedIndex > 0
        ? jobSelEl.options[jobSelEl.selectedIndex].text
        : (val('jobId') || '–');

    const deptSelEl = document.getElementById('dept-select');
    const deptLabel = deptSelEl && deptSelEl.value ? deptSelEl.value : val('jobDepartment');

    const sections = [
        {
            title: 'Personal Details',
            icon: 'fa-user',
            stepIndex: 0,
            rows: [
                { label: 'Full Name', value: val('name') },
                { label: 'Email', value: val('email') },
                { label: 'Phone', value: val('phone') },
                { label: 'Gender', value: val('gender') },
                { label: 'Qualification', value: val('qualification') === 'Other' ? (val('qualificationOther') || 'Other') : val('qualification') },
                { label: 'City', value: val('addressCity') },
                { label: 'State', value: val('addressState') },
                { label: 'Pincode', value: val('addressPincode') },
                { label: 'Street', value: val('addressStreet') },
            ]
        },
        {
            title: 'Professional Details',
            icon: 'fa-briefcase',
            stepIndex: 1,
            rows: [
                { label: 'Current Company', value: val('currentCompany') },
                { label: 'Designation', value: val('designation') },
                { label: 'Experience', value: val('experience') ? `${val('experience')} yrs` : '' },
                { label: 'Source', value: val('source') },
            ]
        },
        {
            title: 'Applied Position',
            icon: 'fa-layer-group',
            stepIndex: 2,
            rows: [
                { label: 'Company', value: (() => { const c = allCompanies.find(c => c.id === (companySelect?.value || '')); return c ? c.name : (companySelect?.value || ''); })() },
                { label: 'Department', value: deptLabel },
                { label: 'Position', value: jobLabel },
            ]
        },
        {
            title: 'CTC & Financials',
            icon: 'fa-indian-rupee-sign',
            stepIndex: 3,
            rows: [
                { label: 'Current CTC', value: val('currentCTC') ? `₹${Number(val('currentCTC')).toLocaleString('en-IN')}/mo` : '' },
                { label: 'Expected CTC', value: val('expectedCTC') ? `₹${Number(val('expectedCTC')).toLocaleString('en-IN')}/mo` : '' },
                { label: 'Notice Period', value: val('noticePeriod') ? `${val('noticePeriod')} days` : '' },
                { label: 'Why Change?', value: val('whyChangeJob') },
            ]
        },
        {
            title: 'Resume',
            icon: 'fa-file-lines',
            stepIndex: 4,
            rows: [
                { label: 'File', value: resumeFileName || '– No file selected' },
            ]
        }
    ];

    reviewEl.innerHTML = `
    <div class="mb-5">
      <p class="text-sm font-semibold text-slate-600 mb-1">
        <i class="fas fa-circle-check text-green-500 mr-1"></i>
        Almost there! Please review your application before submitting.
      </p>
      <p class="text-xs text-slate-400">Click <strong>Edit</strong> on any section to go back and make changes.</p>
    </div>
    <div class="space-y-4">
      ${sections.map(sec => `
        <div class="rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-sm">
          <div class="flex items-center justify-between px-4 py-3 bg-slate-50 border-b border-slate-100">
            <span class="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-slate-500">
              <i class="fas ${sec.icon} text-blue-500"></i> ${sec.title}
            </span>
            <button type="button"
              onclick="window._wizardGoTo(${sec.stepIndex})"
              class="text-[11px] font-bold text-blue-600 hover:text-blue-800 hover:underline flex items-center gap-1 transition">
              <i class="fas fa-pen text-[10px]"></i> Edit
            </button>
          </div>
          <div class="divide-y divide-slate-50">
            ${sec.rows.filter(r => r.value).map(r => `
              <div class="flex px-4 py-2.5 gap-4">
                <span class="text-xs text-slate-400 font-medium w-32 shrink-0">${r.label}</span>
                <span class="text-xs font-semibold text-slate-700 break-words">${r.value.replace(/\n/g, '<br>')}</span>
              </div>
            `).join('')}
            ${sec.rows.every(r => !r.value) ? `
              <div class="px-4 py-3 text-xs text-slate-400 italic">No information provided.</div>
            ` : ''}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

// Expose step-jump helper for the review edit buttons
window._wizardGoTo = (index) => showStep(index);

function validateCurrentStep() {
    const container = stepEls[currentStepIndex];
    if (!container) return true;

    // Clear previous errors
    container.querySelectorAll('.border-red-400').forEach(el => {
        el.classList.remove('border-red-400', 'ring-2', 'ring-red-100');
    });

    const requiredFields = Array.from(container.querySelectorAll('[required]'));
    let firstInvalid = null;

    for (const field of requiredFields) {
        let isValid = true;
        if (field.type === 'file') {
            isValid = field.files && field.files.length > 0;
        } else {
            isValid = field.value && field.value.trim() !== "";
        }

        if (!isValid) {
            field.classList.add('border-red-400', 'ring-2', 'ring-red-100');
            if (!firstInvalid) firstInvalid = field;

            // Add one-time listener to clear error on input
            const clearError = () => {
                field.classList.remove('border-red-400', 'ring-2', 'ring-red-100');
                field.removeEventListener('input', clearError);
                field.removeEventListener('change', clearError);
            };
            field.addEventListener('input', clearError);
            field.addEventListener('change', clearError);
        }
    }

    if (firstInvalid) {
        firstInvalid.focus();
        firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return false;
    }
    return true;
}

if (nextBtn) {
    nextBtn.addEventListener('click', () => {
        if (!validateCurrentStep()) return;
        showStep(currentStepIndex + 1);
    });
}
if (backBtn) {
    backBtn.addEventListener('click', () => {
        showStep(currentStepIndex - 1);
    });
}

// --- AUTHENTICATION FLOW ---
const provider = new GoogleAuthProvider();

// Toggle Login/Signup
authToggleBtn.addEventListener('click', () => {
    authMode = authMode === 'login' ? 'signup' : 'login';
    if (authMode === 'signup') {
        authTitle.textContent = "Create Account";
        authSubtitle.textContent = "Join us and apply for your dream job.";
        emailAuthBtn.textContent = "Sign Up";
        authToggleText.textContent = "Already have an account?";
        authToggleBtn.textContent = "Sign In";
    } else {
        authTitle.textContent = "Candidate Login";
        authSubtitle.textContent = "Please sign in to start your application.";
        emailAuthBtn.textContent = "Sign In";
        authToggleText.textContent = "Don't have an account?";
        authToggleBtn.textContent = "Create Account";
    }
    loginError.classList.add('hidden');
});

// Google Login
googleLoginBtn.addEventListener('click', async () => {
    const originalHtml = googleLoginBtn.innerHTML;
    googleLoginBtn.disabled = true;
    googleLoginBtn.innerHTML = '<div class="loader w-5 h-5 border-4 rounded-full border-t-transparent mr-2 border-slate-400"></div> <span>Signing in...</span>';
    loginError.classList.add('hidden');

    try {
        await signInWithPopup(auth, provider);
    } catch (err) {
        console.error("Google Sign In Error", err);
        loginError.textContent = "Google sign in failed. Please try again.";
        loginError.classList.remove('hidden');
        googleLoginBtn.disabled = false;
        googleLoginBtn.innerHTML = originalHtml;
    }
});

// Email Auth
emailAuthForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = authEmail.value;
    const password = authPassword.value;

    if (password.length < 6) {
        loginError.textContent = "Password should be at least 6 characters.";
        loginError.classList.remove('hidden');
        return;
    }

    const originalBtnHtml = emailAuthBtn.innerHTML;
    emailAuthBtn.disabled = true;
    emailAuthBtn.innerHTML = '<div class="loader w-5 h-5 border-4 rounded-full border-t-transparent mr-2 border-white"></div> <span>Processing...</span>';
    loginError.classList.add('hidden');

    try {
        if (authMode === 'signup') {
            await createUserWithEmailAndPassword(auth, email, password);
        } else {
            await signInWithEmailAndPassword(auth, email, password);
        }
    } catch (err) {
        console.error("Email Auth Error", err);
        loginError.textContent = getFriendlyAuthError(err.code);
        loginError.classList.remove('hidden');
        emailAuthBtn.disabled = false;
        emailAuthBtn.innerHTML = originalBtnHtml;
    }
});

function getFriendlyAuthError(code) {
    switch (code) {
        case 'auth/email-already-in-use': return 'This email is already registered.';
        case 'auth/invalid-email': return 'Invalid email address format.';
        case 'auth/user-not-found': return 'No account found with this email.';
        case 'auth/wrong-password': return 'Incorrect password.';
        default: return 'Authentication failed. Please try again.';
    }
}

// Logout
logoutBtn.addEventListener('click', async () => {
    if (confirm("Are you sure you want to log out?")) {
        try {
            await signOut(auth);
        } catch (err) {
            console.error("Logout Error", err);
        }
    }
});

onAuthStateChanged(auth, async (user) => {
    if (user) {
        authenticatedUser = user;

        // UI Changes
        authContainer.classList.add('hidden');
        formContainer.classList.remove('hidden');
        logoutBtn.classList.remove('hidden');

        // Pre-fill Name and Email
        // For Google, display name exists. For email users, it might be null initially.
        candidateNameInput.value = user.displayName || "";
        candidateEmailInput.value = user.email || "";

        // Allow email users to edit their name if empty
        if (!user.displayName) {
            candidateNameInput.classList.remove('bg-slate-50', 'cursor-not-allowed');
        }

        loadJobs();
    } else {
        // UI Reset
        authContainer.classList.remove('hidden');
        formContainer.classList.add('hidden');
        successMessage.classList.add('hidden');
        logoutBtn.classList.add('hidden');
        form.reset();
        authEmail.value = '';
        authPassword.value = '';
        emailAuthBtn.disabled = false;
        emailAuthBtn.textContent = (authMode === 'login' ? 'Sign In' : 'Sign Up');
        googleLoginBtn.disabled = false;
    }
    // Check if portal is locked whenever auth state changes
    if (portalSettings) applyPortalSettings(portalSettings);
});

// Initialize Portal Settings Listener ONCE
(function initPortalListener() {
    console.log("Initializing Portal Settings Listener...");
    onSnapshot(doc(db, "settings", "publicPortal"), (snapshot) => {
        if (snapshot.exists()) {
            const data = snapshot.data();
            console.log("Portal Settings Updated:", data);
            portalSettings = data;
            applyPortalSettings(data);

            // Trigger Job Reload if visible
            if (allJobs.length > 0) {
                loadJobs();
            }
        } else {
            console.warn("No portal settings found in Firestore.");
        }
    }, (error) => {
        console.error("Portal Settings Sync Error:", error);
    });
})();

// ---- Background Image Preloader ----
let _lastBgUrl = '';
const bgLayer = document.getElementById('bg-layer');

function applyBackgroundImage(url) {
    if (url === _lastBgUrl) return; // same URL — skip flash & re-download
    _lastBgUrl = url;

    // Fade out while the new image loads
    bgLayer.classList.remove('bg-loaded');

    const img = new Image();
    img.onload = () => {
        bgLayer.style.backgroundImage = `url('${url}')`;
        // Tiny delay so the opacity transition is visible
        requestAnimationFrame(() => bgLayer.classList.add('bg-loaded'));
    };
    img.onerror = () => {
        console.warn('Background image failed to load:', url);
    };
    img.src = url;
}

function clearBackgroundImage() {
    if (_lastBgUrl === '') return;
    _lastBgUrl = '';
    bgLayer.classList.remove('bg-loaded');
    // Clear the image after the fade-out transition ends
    setTimeout(() => { bgLayer.style.backgroundImage = 'none'; }, 420);
}

// Map from portal step id → HTML element id
const STEP_ID_MAP = {
    personal: 'step-personal',
    professional: 'step-professional',
    position: 'step-position',
    financials: 'step-financials',
    resume: 'step-resume',
    review: 'step-review'
};

// Full catalogue of all possible steps
const ALL_WIZARD_STEPS = [
    { id: 'step-personal', label: 'Personal Details', settingId: 'personal', alwaysOn: true },
    { id: 'step-professional', label: 'Professional Details', settingId: 'professional', alwaysOn: false },
    { id: 'step-position', label: 'Applied Position', settingId: 'position', alwaysOn: false },
    { id: 'step-financials', label: 'CTC & Financials', settingId: 'financials', alwaysOn: false },
    { id: 'step-resume', label: 'Resume Upload', settingId: 'resume', alwaysOn: false },
    { id: 'step-review', label: 'Review & Submit', settingId: 'review', alwaysOn: true }
];

function applyWizardSteps(stepsConfig) {
    // Build a lookup: settingId → enabled
    const enabledMap = {};
    (stepsConfig || []).forEach(s => { enabledMap[s.id] = s.enabled !== false; });

    // Rebuild the live wizardSteps array that the rest of the wizard uses
    wizardSteps.length = 0;
    ALL_WIZARD_STEPS.forEach(def => {
        const el = document.getElementById(def.id);
        if (!el) return;
        const isEnabled = def.alwaysOn || enabledMap[def.settingId] !== false;
        if (isEnabled) {
            // Make step visible (it may have been hidden by a previous call)
            el.style.display = '';
            // Re-enable required fields
            el.querySelectorAll('[data-was-required]').forEach(field => {
                field.required = true;
                field.removeAttribute('data-was-required');
            });
            wizardSteps.push({ id: def.id, label: def.label });
        } else {
            // Hide step element
            el.style.display = 'none';
            // Strip required so the browser doesn't block submission
            el.querySelectorAll('[required]').forEach(field => {
                field.setAttribute('data-was-required', '1');
                field.required = false;
            });
        }
    });

    // Also rebuild stepEls reference so showStep works
    stepEls.length = 0;
    wizardSteps.forEach(s => stepEls.push(document.getElementById(s.id)));

    // Reset to first step safely
    currentStepIndex = 0;
    showStep(0);
}

// Shared function to apply settings
function applyPortalSettings(data) {
    if (!data) return;

    // Apply wizard step visibility first
    if (data.steps) applyWizardSteps(data.steps);

    // 0. Handle Typography & Global Background
    if (data.fontFamily) {
        document.body.style.fontFamily = data.fontFamily;
    }
    if (data.backgroundUrl) {
        applyBackgroundImage(data.backgroundUrl);
        document.body.classList.remove('bg-slate-50', 'dark:bg-slate-950');
    } else {
        clearBackgroundImage();
        document.body.classList.add('bg-slate-50', 'dark:bg-slate-950');
    }

    // UX & Styling logic removed as per request (falling back to CSS defaults)

    // 1. Handle Locked State
    const lockedContainer = document.getElementById('locked-container');
    const authContainerEl = document.getElementById('auth-container');
    const formContainerEl = document.getElementById('form-container');

    if (data.isLocked) {
        lockedContainer.classList.remove('hidden');
        authContainerEl.classList.add('hidden');
        formContainerEl.classList.add('hidden');
        if (logoutBtn) logoutBtn.classList.add('hidden');
    } else {
        lockedContainer.classList.add('hidden');
        if (authenticatedUser) {
            formContainerEl.classList.remove('hidden');
            authContainerEl.classList.add('hidden');
            if (logoutBtn) logoutBtn.classList.remove('hidden');
        } else {
            authContainerEl.classList.remove('hidden');
            formContainerEl.classList.add('hidden');
        }
    }

    // 2. Handle Branding - Logo & Banner
    if (data.logoUrl) {
        document.getElementById('portal-logo-container').classList.remove('hidden');
        document.getElementById('portal-logo').src = data.logoUrl;

        const footerLogoContainer = document.getElementById('footer-logo-container');
        if (footerLogoContainer) {
            footerLogoContainer.classList.remove('hidden');
            footerLogoContainer.classList.add('flex');
            document.getElementById('footer-logo').src = data.logoUrl;
        }
    } else {
        document.getElementById('portal-logo-container').classList.add('hidden');
        const footerLogoContainer = document.getElementById('footer-logo-container');
        if (footerLogoContainer) {
            footerLogoContainer.classList.add('hidden');
            footerLogoContainer.classList.remove('flex');
        }
    }

    // 3. Handle Welcome Text & Colors
    if (data.companyPrompt) {
        document.getElementById('portal-brand-tagline').innerText = data.companyPrompt;
    }

    // 3.1 About Company Content
    const aboutContainer = document.getElementById('portal-about-container');
    const aboutText = document.getElementById('portal-about-text');
    if (data.aboutCompany && aboutContainer && aboutText && !data.isLocked) {
        aboutContainer.classList.remove('hidden');
        aboutText.innerText = data.aboutCompany;

    } else if (aboutContainer) {
        aboutContainer.classList.add('hidden');
    }

    // 3.2 Footer & Social
    const footerEmail = document.getElementById('footer-support-email');
    const footerPhone = document.getElementById('footer-support-phone');
    if (data.supportEmail && footerEmail) {
        footerEmail.classList.remove('hidden');
        footerEmail.classList.add('flex');
        document.getElementById('footer-email-text').innerText = data.supportEmail;
        const emailLink = document.getElementById('footer-email-link');
        if (emailLink) emailLink.href = 'mailto:' + data.supportEmail;
    }
    if (data.supportPhone && footerPhone) {
        footerPhone.classList.remove('hidden');
        footerPhone.classList.add('flex');
        document.getElementById('footer-phone-text').innerText = data.supportPhone;
        const phoneLink = document.getElementById('footer-phone-link');
        if (phoneLink) phoneLink.href = 'tel:' + data.supportPhone;
    }

    const socialLinks = {
        'link-linkedin': data.socialLinkedin
    };
    Object.keys(socialLinks).forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            if (socialLinks[id]) {
                el.classList.remove('hidden');
                el.href = socialLinks[id];
            } else {
                el.classList.add('hidden');
            }
        }
    });

    const footerYear = document.getElementById('footer-year');
    if (footerYear) footerYear.innerText = new Date().getFullYear();
    // footerBrand handling removed or simplified if companyName not in data
    const footerBrand = document.getElementById('footer-brand-name');
    if (footerBrand) footerBrand.innerText = data.companyName || "Recruitment Suite";
    const ftBrandLogo = document.getElementById('footer-brand-name-logo');
    if (ftBrandLogo) ftBrandLogo.innerText = data.companyName || "Recruitment Suite";

    if (data.primaryColor) {
        const color = data.primaryColor;
        const brandName = document.getElementById('portal-brand-name');
        brandName.style.color = color;
        brandName.classList.remove('text-blue-600');

        const buttons = [
            document.getElementById('email-auth-btn'),
            document.getElementById('submit-btn'),
            document.getElementById('auth-toggle-btn'),
            document.getElementById('wizard-next-btn'),
            document.getElementById('wizard-back-btn')
        ];
        buttons.forEach(btn => {
            if (btn) {
                if (btn.id === 'auth-toggle-btn' || btn.id === 'wizard-back-btn') {
                    btn.style.color = color;
                } else {
                    btn.style.backgroundColor = color;
                    btn.classList.remove('bg-blue-600', 'hover:bg-blue-700');
                }
            }
        });

        const highlights = document.querySelectorAll('.text-blue-500, .text-blue-600, .text-blue-700, .bg-blue-600');
        highlights.forEach(el => {
            if (el.id !== 'portal-brand-name' && !el.closest('button')) {
                if (el.classList.contains('bg-blue-600')) {
                    el.style.backgroundColor = color;
                } else {
                    el.style.color = color;
                }
            }
        });

        const styleId = 'theme-style-override';
        let style = document.getElementById(styleId);
        if (!style) {
            style = document.createElement('style');
            style.id = styleId;
            document.head.appendChild(style);
        }
        style.innerHTML = `
            .theme-input:focus { border-color: ${color} !important; box-shadow: 0 0 0 3px ${color}20 !important; }
            .border-blue-200 { border-color: ${color}40 !important; }
            .bg-blue-50 { background-color: ${color}10 !important; }
            .text-blue-500 { color: ${color} !important; }
            .text-blue-600 { color: ${color} !important; }
            .peer-checked\\:bg-blue-600:checked ~ div { background-color: ${color} !important; }
            #wizard-progress-bar { background-color: ${color} !important; }
        `;
    }
}

// File Input Change Listener
resumeFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        resumeFileLabel.textContent = file.name;
        resumeFileLabel.classList.remove('text-blue-700');
        resumeFileLabel.classList.add('text-slate-700', 'font-bold');
    } else {
        resumeFileLabel.textContent = 'Click or drag file to upload';
        resumeFileLabel.classList.add('text-blue-700');
        resumeFileLabel.classList.remove('text-slate-700', 'font-bold');
    }
});

// Load Jobs
async function loadJobs() {
    try {
        if (companySelect) companySelect.innerHTML = '<option value="">Loading...</option>';
        if (deptSelect) deptSelect.innerHTML = '<option value="">Loading...</option>';
        if (jobSelect) jobSelect.innerHTML = '<option value="">Loading...</option>';

        // Fetch companies
        const companiesSnapshot = await getDocs(collection(db, 'companies'));
        const allCompaniesRaw = [];
        companiesSnapshot.forEach(docSnap => allCompaniesRaw.push({ id: docSnap.id, ...docSnap.data() }));
        allCompaniesRaw.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

        const jobsSnapshot = await getDocs(collection(db, 'jobs'));
        allJobs = [];

        // Get visibility constraints from settings
        const openCompanies = portalSettings?.openCompanies || [];
        const openDepts = portalSettings?.openDepartments || [];
        const openPositions = portalSettings?.openPositions || [];

        jobsSnapshot.forEach(docSnap => {
            const data = docSnap.data();
            if (data.status === 'Open') {
                const compMatch = openCompanies.length === 0 || openCompanies.includes(data.companyId);
                const deptMatch = openDepts.length === 0 || openDepts.includes(data.department);
                const posMatch = openPositions.length === 0 || openPositions.includes(data.title);
                if (compMatch && deptMatch && posMatch) {
                    allJobs.push({ id: docSnap.id, ...data });
                }
            }
        });

        // Filter companies to only those that have visible jobs
        const companyIdsWithJobs = new Set(allJobs.map(j => j.companyId).filter(Boolean));
        allCompanies = allCompaniesRaw.filter(c => companyIdsWithJobs.has(c.id));

        // Populate Company dropdown
        if (companySelect) {
            companySelect.innerHTML = '<option value="">-- Select Company --</option>';
            allCompanies.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c.id;
                opt.textContent = c.name || c.id;
                companySelect.appendChild(opt);
            });
        }

        // Reset dependent dropdowns
        if (deptSelect) deptSelect.innerHTML = '<option value="">-- Select Company First --</option>';
        if (jobSelect) jobSelect.innerHTML = '<option value="">-- Select Company First --</option>';

    } catch (err) {
        console.error("Error loading jobs: ", err);
        if (companySelect) companySelect.innerHTML = '<option value="">Error Loading</option>';
        if (deptSelect) deptSelect.innerHTML = '<option value="">Error Loading</option>';
        if (jobSelect) jobSelect.innerHTML = '<option value="">Error Loading</option>';
    }
}

function populateDepts(companyId) {
    const jobs = companyId ? allJobs.filter(j => j.companyId === companyId) : allJobs;
    const depts = [...new Set(jobs.map(j => j.department).filter(Boolean))].sort();
    if (deptSelect) {
        deptSelect.innerHTML = '<option value="">-- All Departments --</option>';
        depts.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d;
            opt.textContent = d;
            deptSelect.appendChild(opt);
        });
    }
    // Reset position dropdown when company changes
    if (jobSelect) jobSelect.innerHTML = '<option value="">-- Select Position --</option>';
    populateJobs(companyId, '');
}

function populateJobs(companyId = "", filteredDept = "") {
    if (!jobSelect) return;
    jobSelect.innerHTML = '<option value="">-- Select Position --</option>';
    let filteredJobs = allJobs;
    if (companyId) filteredJobs = filteredJobs.filter(j => j.companyId === companyId);
    if (filteredDept) filteredJobs = filteredJobs.filter(j => j.department === filteredDept);
    filteredJobs.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
    filteredJobs.forEach(job => {
        const opt = document.createElement('option');
        opt.value = job.id;
        opt.textContent = job.title || job.id;
        jobSelect.appendChild(opt);
    });
}

if (companySelect) {
    companySelect.addEventListener('change', (e) => {
        populateDepts(e.target.value);
        document.getElementById('job-description-container').classList.add('hidden');
    });
}

if (deptSelect) {
    deptSelect.addEventListener('change', (e) => {
        const companyId = companySelect ? companySelect.value : '';
        populateJobs(companyId, e.target.value);
        document.getElementById('job-description-container').classList.add('hidden');
    });
}

jobSelect.addEventListener('change', (e) => {
    const jobId = e.target.value;
    const container = document.getElementById('job-description-container');
    const content = document.getElementById('job-description-content');

    if (jobId) {
        const job = allJobs.find(j => j.id === jobId);
        if (job && job.description && job.description.trim()) {
            content.textContent = job.description; // Use textContent for safety, whitespace-pre-line handles display
            container.classList.remove('hidden');
        } else {
            container.classList.add('hidden');
        }
    } else {
        container.classList.add('hidden');
    }
});

// Cloudinary Upload Logic
async function uploadResumeToCloudinary(file) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', CLOUDINARY_PRESET);
    formData.append('folder', 'resume_uploads/candidates');
    const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_').substring(0, 50);
    formData.append('public_id', `candidate_${Date.now()}_${safeName}`);

    const res = await fetch(CLOUDINARY_URL.replace('/auto/', '/raw/'), {
        method: 'POST',
        body: formData
    });

    if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error?.message || 'Failed to upload resume to internet');
    }

    const data = await res.json();
    const versionIndex = data.secure_url.indexOf('/v');
    if (versionIndex !== -1) {
        const versionEndIndex = data.secure_url.indexOf('/', versionIndex + 1);
        return data.secure_url.substring(0, versionIndex) + data.secure_url.substring(versionEndIndex);
    }
    return data.secure_url;
}

// Handle Form Submission
form.addEventListener('submit', async (e) => {
    e.preventDefault();

    // Validate file size manually (5MB max)
    const file = resumeFileInput.files[0];
    if (file && file.size > 5 * 1024 * 1024) {
        alert("Resume file size should be less than 5MB.");
        return;
    }

    const originalBtnHtml = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<div class="loader w-5 h-5 border-4 rounded-full border-t-transparent mr-2"></div> <span>Submitting...</span>';
    submitBtn.classList.add('opacity-80', 'cursor-not-allowed');

    try {
        const formData = new FormData(form);
        const data = Object.fromEntries(formData.entries());

        // --- GRACEFUL JOB CLOSURE CHECK ---
        if (data.jobId) {
            const jobRef = doc(db, 'jobs', data.jobId);
            const jobSnap = await getDoc(jobRef);
            if (jobSnap.exists()) {
                const jobData = jobSnap.data();

                // If it's explicitly Draft, block perfectly.
                if (jobData.status === 'Draft') {
                    alert("This job is currently in Draft mode and cannot accept applications.");
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = originalBtnHtml;
                    submitBtn.classList.remove('opacity-80', 'cursor-not-allowed');
                    return;
                }

                // If Closed, check Grace Period
                if (jobData.status === 'Closed') {
                    // Assume 30 minutes grace period
                    let gracePeriodPassed = true;
                    if (jobData.closingDate) {
                        try {
                            // The closingDate might be just 'YYYY-MM-DD'. Let's parse it.
                            // If they used the quick-toggle recently, the timestamp might not be precise,
                            // but if it's identical to 'today' (the date portion), we give them the grace.
                            const todayStr = new Date().toISOString().split('T')[0];
                            if (jobData.closingDate === todayStr) {
                                // Close happened today, allow grace
                                gracePeriodPassed = false;
                            }
                        } catch (e) { }
                    }
                    if (gracePeriodPassed) {
                        alert("We're sorry, but this job opening has just been closed. Thank you for your interest.");
                        submitBtn.disabled = false;
                        submitBtn.innerHTML = originalBtnHtml;
                        submitBtn.classList.remove('opacity-80', 'cursor-not-allowed');
                        return;
                    }
                }
            } else {
                alert("We're sorry, this job no longer exists.");
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalBtnHtml;
                submitBtn.classList.remove('opacity-80', 'cursor-not-allowed');
                return;
            }
        }
        // ----------------------------------

        let resumeUrl = "";
        if (file) {
            resumeUrl = await uploadResumeToCloudinary(file);
        }

        // Selected Job Details
        const selectedJob = allJobs.find(j => j.id === data.jobId);
        const jobTitle = selectedJob ? selectedJob.title : "";
        const jobDepartment = data.jobDepartment || (selectedJob ? selectedJob.department : "");

        const candidateData = {
            name: data.name || "",
            email: data.email || "",
            phone: data.phone || "",
            gender: data.gender || "",
            qualification: data.qualification === 'Other' ? (data.qualificationOther || 'Other') : (data.qualification || ""),

            // Structured address fields
            addressStreet: data.addressStreet || "",
            addressCity: data.addressCity || "",
            addressState: data.addressState || "",
            addressPincode: data.addressPincode || "",
            // Composite address for backwards-compat display
            address: [data.addressStreet, data.addressCity, data.addressState, data.addressPincode].filter(Boolean).join(', '),

            currentCompany: data.currentCompany || "",
            designation: data.designation || "",
            experience: data.experience ? parseFloat(data.experience) : 0,

            jobDepartment: jobDepartment,
            jobId: data.jobId || "",
            jobTitle: jobTitle,

            currentCTC: data.currentCTC ? parseFloat(data.currentCTC) : 0,
            expectedCTC: data.expectedCTC ? parseFloat(data.expectedCTC) : 0,
            noticePeriod: data.noticePeriod ? parseInt(data.noticePeriod, 10) : 0,
            whyChangeJob: data.whyChangeJob || "",

            source: data.source || "Job Portal",
            status: "Sourced",
            inTalentPool: true,
            isNew: true,
            resumeUrl: resumeUrl,

            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        };

        // Save to Firestore (Talent Pool Inbox)
        await addDoc(collection(db, 'talentpool'), candidateData);

        // Show Success Message
        formContainer.classList.add('hidden');
        successMessage.classList.remove('hidden');
        successMessage.classList.add('flex');

        window.scrollTo({ top: 0, behavior: 'smooth' });

        form.reset();
        resumeFileLabel.textContent = 'Click or drag file to upload';
        resumeFileLabel.classList.add('text-blue-700');
        resumeFileLabel.classList.remove('text-slate-700', 'font-bold');
    } catch (err) {
        console.error(err);
        alert("Error submitting application: " + err.message);
        submitBtn.disabled = false;
        submitBtn.innerHTML = originalBtnHtml;
        submitBtn.classList.remove('opacity-80', 'cursor-not-allowed');
    }
});

// initialization happens dynamically inside onAuthStateChanged instead of DOMContentLoaded
// Initial wizard step
showStep(0);


