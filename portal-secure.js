(() => {
  'use strict';

  const EMPTY_DB = () => ({participants:[],certificates:[],trainings:[],requests:[],payments:[],schedules:[]});
  const RECORD_TYPES = ['participants','certificates','trainings','requests','payments','schedules'];
  const CLIENT_WRITABLE = new Set(['participants','requests','payments']);
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const LIVE_URL = 'https://1020safetyconsultancy-dot.github.io/1020STCS-PORTAL/';
  const PAYMENT_PROOF_BUCKET = 'payment-proofs';
  const PAYMENT_PROOF_MAX_BYTES = 5 * 1024 * 1024;
  const PAYMENT_PROOF_EXTENSIONS = new Map([['image/jpeg','jpg'],['image/png','png'],['image/webp','webp']]);
  const recordOwners = new Map();
  const recordSnapshot = new Map();
  let authListener = null;
  let authLoading = false;
  const authRedirectParams = new URLSearchParams((location.hash || location.search || '').replace(/^[#?]/, ''));
  const authRedirectErrorCode = authRedirectParams.get('error_code') || '';
  const authRedirectErrorDescription = authRedirectParams.get('error_description') || '';
  let recoveryMode = /(?:[?#&])type=recovery(?:&|$)/.test(location.href) && !authRedirectErrorCode;

  function resultBox(id, type, message) {
    const el = $(id);
    if (!el) return;
    el.className = `result ${type || ''}`.trim();
    el.style.display = message ? 'block' : 'none';
    el.textContent = message || '';
  }

  function authCard(id) {
    ['authLoginCard','forgotCard','recoveryCard','registerCard'].forEach(card => {
      const el = $(card);
      if (el) el.style.display = card === id ? 'block' : 'none';
    });
    $('loginScreen').style.display = 'flex';
  }

  function profileUser(profile) {
    return {
      id: profile.user_id,
      user_id: profile.user_id,
      name: profile.name || profile.email,
      username: profile.email,
      email: profile.email,
      company: profile.company || '',
      contact: profile.contact || '',
      role: profile.role,
      active: profile.active !== false,
      created_at: profile.created_at
    };
  }

  function recordKey(type, id) { return `${type}:${id}`; }
  function isStaff() { return current && (current.role === 'admin' || current.role === 'consultant'); }

  function clearPortalMemory() {
    current = null;
    users = [];
    db = EMPTY_DB();
    recordOwners.clear();
    recordSnapshot.clear();
    cloudReady = false;
  }

  function ownerFor(type, item) {
    const key = recordKey(type, item.id);
    const remembered = recordOwners.get(key);
    if (remembered && UUID_RE.test(remembered)) return remembered;
    for (const candidate of [item.ownerId, item.clientId]) {
      if (candidate && UUID_RE.test(String(candidate))) return String(candidate);
    }
    if (type === 'participants' && item.sourceRequestId) {
      const request = db.requests.find(r => r.id === item.sourceRequestId);
      const requestOwner = request && ownerFor('requests', request);
      if (requestOwner) return requestOwner;
    }
    if (type === 'certificates' && item.pid) {
      const participant = db.participants.find(p => p.id === item.pid);
      const participantOwner = participant && ownerFor('participants', participant);
      if (participantOwner) return participantOwner;
    }
    if (item.company) {
      const company = String(item.company).trim().toLowerCase();
      const matches = users.filter(u => u.role === 'client' && String(u.company || '').trim().toLowerCase() === company);
      if (matches.length === 1) return matches[0].id;
    }
    return current && current.role === 'client' ? current.id : null;
  }

  function canWriteRecord(type, item) {
    if (isStaff()) return true;
    return current?.role === 'client' && CLIENT_WRITABLE.has(type) && ownerFor(type, item) === current.id;
  }

  async function loadProfiles() {
    const {data, error} = await portalSupabase
      .from('profiles')
      .select('user_id,email,name,company,contact,role,active,created_at,updated_at')
      .order('created_at', {ascending:true});
    if (error) throw error;
    users = (data || []).map(profileUser);
    const own = users.find(user => user.id === current?.id);
    if (own) current = own;
  }

  async function loadPortalRecords() {
    const {data, error} = await portalSupabase
      .from('portal_records')
      .select('id,record_type,owner_id,company,data,updated_at');
    if (error) throw error;
    db = EMPTY_DB();
    recordOwners.clear();
    recordSnapshot.clear();
    (data || []).forEach(row => {
      if (!RECORD_TYPES.includes(row.record_type)) return;
      const item = {...(row.data || {}), id: row.id};
      if (row.owner_id) item.ownerId = row.owner_id;
      if (row.owner_id && ['requests','payments'].includes(row.record_type) && !UUID_RE.test(String(item.clientId || ''))) {
        item.clientId = row.owner_id;
      }
      db[row.record_type].push(item);
      const key = recordKey(row.record_type, row.id);
      recordOwners.set(key, row.owner_id || null);
      recordSnapshot.set(key, JSON.stringify(item));
    });
  }

  window.secureCloudLoad = async function secureCloudLoad() {
    if (authLoading) return;
    authLoading = true;
    try {
      cloudStatus('', 'Securely loading portal data…');
      const {data:{session}, error:sessionError} = await portalSupabase.auth.getSession();
      if (sessionError) throw sessionError;
      if (!session) {
        clearPortalMemory();
        authCard('authLoginCard');
        cloudStatus('', 'Sign in to connect');
        return;
      }
      const {data:profile, error:profileError} = await portalSupabase
        .from('profiles')
        .select('user_id,email,name,company,contact,role,active,created_at,updated_at')
        .eq('user_id', session.user.id)
        .single();
      if (profileError || !profile) throw new Error('Your portal profile could not be loaded.');
      if (!profile.active) {
        await portalSupabase.auth.signOut();
        throw new Error('This account is inactive. Please contact the administrator.');
      }
      current = profileUser(profile);
      await Promise.all([loadProfiles(), loadPortalRecords()]);
      cloudReady = true;
      $('loginScreen').style.display = 'none';
      applyPermissions();
      syncUser();
      go('dash');
      render();
      cloudStatus('online', 'Secure online database connected');
    } catch (error) {
      console.error(error);
      clearPortalMemory();
      authCard('authLoginCard');
      cloudStatus('error', 'Secure connection unavailable');
      alert(error.message || 'Unable to load the secure portal.');
    } finally {
      authLoading = false;
    }
  };

  window.secureCloudWrite = async function secureCloudWrite() {
    if (!cloudReady || !current) return;
    if (cloudSaving) { cloudQueued = true; return; }
    cloudSaving = true;
    try {
      const currentKeys = new Set();
      const changedRows = [];
      const changedItems = [];

      RECORD_TYPES.forEach(type => {
        (db[type] || []).forEach(item => {
          if (!item?.id) return;
          const key = recordKey(type, item.id);
          currentKeys.add(key);
          const owner = ownerFor(type, item);
          if (owner) item.ownerId = owner;
          const serialized = JSON.stringify(item);
          if (recordSnapshot.get(key) === serialized || !canWriteRecord(type, item)) return;
          changedRows.push({
            id: String(item.id),
            record_type: type,
            owner_id: owner,
            company: String(item.company || ''),
            data: item,
            updated_at: new Date().toISOString()
          });
          changedItems.push({key, serialized, owner});
        });
      });

      const deleted = [];
      for (const key of recordSnapshot.keys()) {
        if (currentKeys.has(key)) continue;
        const split = key.indexOf(':');
        const type = key.slice(0, split), id = key.slice(split + 1);
        const ownerId = recordOwners.get(key);
        if (isStaff() || (current.role === 'client' && CLIENT_WRITABLE.has(type) && ownerId === current.id)) {
          deleted.push({key,type,id});
        }
      }

      if (changedRows.length) {
        const {error} = await portalSupabase
          .from('portal_records')
          .upsert(changedRows, {onConflict:'id,record_type'});
        if (error) throw error;
        changedItems.forEach(change => {
          recordSnapshot.set(change.key, change.serialized);
          recordOwners.set(change.key, change.owner || null);
        });
      }

      for (const entry of deleted) {
        const {error} = await portalSupabase
          .from('portal_records')
          .delete()
          .eq('id', entry.id)
          .eq('record_type', entry.type);
        if (error) throw error;
        recordSnapshot.delete(entry.key);
        recordOwners.delete(entry.key);
      }
      cloudStatus('online', changedRows.length || deleted.length ? 'Saved securely online' : 'Online database connected');
    } catch (error) {
      console.error(error);
      cloudStatus('error', 'Changes not saved — please retry');
      alert(`Secure save failed: ${error.message || 'Unknown database error'}`);
    } finally {
      cloudSaving = false;
      if (cloudQueued) { cloudQueued = false; queueCloudSave(); }
    }
  };

  window.secureShowLogin = function secureShowLogin() {
    recoveryMode = false;
    authCard('authLoginCard');
    resultBox('forgotResult', '', '');
    resultBox('registerResult', '', '');
    hidePassword('loginPass');
    setTimeout(() => ($('loginUser').value ? $('loginPass') : $('loginUser')).focus(), 0);
  };

  window.secureShowRegister = function secureShowRegister() {
    authCard('registerCard');
    ['regName','regCompany','regEmail','regContact','regPassword','regConfirm'].forEach(id => { if ($(id)) $(id).value = ''; });
    resultBox('registerResult', '', '');
    setTimeout(() => $('regName').focus(), 0);
  };

  window.secureShowForgot = function secureShowForgot() {
    authCard('forgotCard');
    $('forgotEmail').value = $('loginUser').value.trim();
    resultBox('forgotResult', '', '');
    setTimeout(() => $('forgotEmail').focus(), 0);
  };

  window.secureLogin = async function secureLogin(event) {
    event.preventDefault();
    const email = $('loginUser').value.trim().toLowerCase();
    const password = $('loginPass').value;
    const selectedRole = document.querySelector('input[name="loginRole"]:checked')?.value || 'admin';
    const submit = event.submitter;
    if (submit) submit.disabled = true;
    try {
      const {data, error} = await portalSupabase.auth.signInWithPassword({email, password});
      if (error || !data.user) throw new Error('Invalid email, password, or account type.');
      const {data:profile, error:profileError} = await portalSupabase
        .from('profiles')
        .select('role,active')
        .eq('user_id', data.user.id)
        .single();
      if (profileError || !profile?.active || profile.role !== selectedRole) {
        await portalSupabase.auth.signOut();
        throw new Error('Invalid email, password, or account type.');
      }
      $('loginPass').value = '';
      await window.secureCloudLoad();
    } catch (error) {
      alert(error.message || 'Unable to sign in.');
    } finally {
      if (submit) submit.disabled = false;
    }
  };

  window.secureRegisterClient = async function secureRegisterClient(event) {
    event.preventDefault();
    const name = $('regName').value.trim();
    const company = $('regCompany').value.trim();
    const email = $('regEmail').value.trim().toLowerCase();
    const contact = $('regContact').value.trim();
    const password = $('regPassword').value;
    const confirmPassword = $('regConfirm').value;
    if (password !== confirmPassword) return resultBox('registerResult','bad','Passwords do not match.');
    const submit = event.submitter;
    if (submit) submit.disabled = true;
    try {
      const {data, error} = await portalSupabase.auth.signUp({
        email,
        password,
        options:{data:{name,company,contact}}
      });
      if (error) throw error;
      if (data.session) {
        await window.secureCloudLoad();
      } else {
        resultBox('registerResult','ok','Registration received. Check your email and confirm your account before signing in.');
      }
    } catch (error) {
      resultBox('registerResult','bad',error.message || 'Registration could not be completed.');
    } finally {
      if (submit) submit.disabled = false;
    }
  };

  window.secureRequestPasswordReset = async function secureRequestPasswordReset(event) {
    event.preventDefault();
    const email = $('forgotEmail').value.trim().toLowerCase();
    const submit = event.submitter;
    if (submit) submit.disabled = true;
    try {
      const {error} = await portalSupabase.auth.resetPasswordForEmail(email, {redirectTo:LIVE_URL});
      if (error) throw error;
      resultBox('forgotResult','ok','If the email is registered, a secure reset link has been sent. Open only the newest email link once; it will return to the live 1020 Safety Portal.');
    } catch (error) {
      resultBox('forgotResult','bad',error.message || 'The reset email could not be sent.');
    } finally {
      if (submit) submit.disabled = false;
    }
  };

  function showRecovery() {
    recoveryMode = true;
    authCard('recoveryCard');
    $('recoveryNewPass').value = '';
    $('recoveryConfirmPass').value = '';
    resultBox('recoveryResult','','');
    setTimeout(() => $('recoveryNewPass').focus(), 0);
  }

  window.secureCompletePasswordRecovery = async function secureCompletePasswordRecovery(event) {
    event.preventDefault();
    const password = $('recoveryNewPass').value;
    const confirmPassword = $('recoveryConfirmPass').value;
    if (password !== confirmPassword) return resultBox('recoveryResult','bad','Passwords do not match.');
    const submit = event.submitter;
    if (submit) submit.disabled = true;
    try {
      const {error} = await portalSupabase.auth.updateUser({password});
      if (error) throw error;
      resultBox('recoveryResult','ok','Password updated successfully. Returning to login…');
      await portalSupabase.auth.signOut();
      history.replaceState({}, document.title, location.pathname);
      setTimeout(window.secureShowLogin, 900);
    } catch (error) {
      resultBox('recoveryResult','bad',error.message || 'Password update failed. Request a new reset link.');
    } finally {
      if (submit) submit.disabled = false;
    }
  };

  window.secureLogout = async function secureLogout() {
    if (!confirm('Log out of the current account?')) return;
    await portalSupabase.auth.signOut();
    $('loginPass').value = '';
    clearPortalMemory();
    window.secureShowLogin();
    cloudStatus('', 'Signed out securely');
  };

  window.myParticipants = function secureParticipants() { return db.participants || []; };
  window.myCertificates = function secureCertificates() { return db.certificates || []; };

  window.secureSaveClientProfile = async function secureSaveClientProfile() {
    if (current?.role !== 'client') return;
    const name = $('clientName').value.trim();
    const company = $('clientCompany').value.trim();
    const email = $('clientEmail').value.trim().toLowerCase();
    const contact = $('clientContact').value.trim();
    if (!name || !company) return alert('Contact Person and Company / Organization are required.');
    try {
      const {error} = await portalSupabase.from('profiles').update({name,company,contact,updated_at:new Date().toISOString()}).eq('user_id', current.id);
      if (error) throw error;
      let emailNotice = '';
      if (email && email !== current.email) {
        const {error:emailError} = await portalSupabase.auth.updateUser({email});
        if (emailError) throw emailError;
        emailNotice = ' Confirm the email-address change using the message sent to your inbox.';
      }
      current = {...current,name,company,contact};
      await loadProfiles();
      syncUser();
      render();
      const box = $('profileSaved');
      box.className = 'result ok';box.style.display = 'block';box.textContent = '✓ Profile updated securely.' + emailNotice;
      setTimeout(() => box.style.display = 'none', 4000);
    } catch (error) {
      alert(error.message || 'Profile update failed.');
    }
  };

  window.secureSaveAdminProfile = async function secureSaveAdminProfile() {
    if (current?.role !== 'admin') return;
    const name = $('adminNameInput').value.trim();
    const email = $('adminUserInput').value.trim().toLowerCase();
    if (!name || !email) return alert('Administrator name and email are required.');
    try {
      const {error} = await portalSupabase.from('profiles').update({name,updated_at:new Date().toISOString()}).eq('user_id', current.id);
      if (error) throw error;
      let notice = '';
      if (email !== current.email) {
        const {error:emailError} = await portalSupabase.auth.updateUser({email});
        if (emailError) throw emailError;
        notice = ' Confirm the email change from your inbox.';
      }
      current.name = name;
      await loadProfiles();
      syncUser();render();
      alert('Administrator account updated securely.' + notice);
    } catch (error) {
      alert(error.message || 'Account update failed.');
    }
  };

  window.secureChangePassword = function secureChangePassword() {
    modal('Change Account Password', `<form class="form" onsubmit="savePassword(event)"><div class="field"><label>Current Password</label><input id="oldPass" type="password" autocomplete="current-password" required></div><div class="field"><label>New Password</label><input id="newPass" type="password" minlength="8" autocomplete="new-password" required></div><div class="field"><label>Confirm New Password</label><input id="confirmPass" type="password" minlength="8" autocomplete="new-password" required></div><div class="actions"><button type="button" class="btn gray" onclick="closeM()">Cancel</button><button class="btn primary">Update Password</button></div></form>`);
  };

  window.secureSavePassword = async function secureSavePassword(event) {
    event.preventDefault();
    if (newPass.value !== confirmPass.value) return alert('New passwords do not match.');
    const submit = event.submitter;
    if (submit) submit.disabled = true;
    try {
      const {error:verifyError} = await portalSupabase.auth.signInWithPassword({email:current.email,password:oldPass.value});
      if (verifyError) throw new Error('Current password is incorrect.');
      const {error} = await portalSupabase.auth.updateUser({password:newPass.value});
      if (error) throw error;
      closeM();alert('Password changed securely.');
    } catch (error) {
      alert(error.message || 'Password change failed.');
    } finally {
      if (submit) submit.disabled = false;
    }
  };

  async function edgeError(error) {
    try {
      const body = await error.context.json();
      return body.error || body.message || error.message;
    } catch {
      return error.message || 'User-management request failed.';
    }
  }

  window.userModal = function secureUserModal(id='') {
    if (current?.role !== 'admin') return;
    const user = users.find(item => item.id === id);
    modal(user ? 'Edit Portal User' : 'Add Portal User', `<form class="form" onsubmit="secureSaveManagedUser(event,'${esc(id)}')"><div class="grid"><div class="field"><label>Full Name *</label><input id="managedName" required value="${esc(user?.name || '')}"></div><div class="field"><label>Email Address *</label><input id="managedEmail" type="email" required value="${esc(user?.email || '')}"></div><div class="field"><label>Role *</label><select id="managedRole" required><option value="client" ${user?.role==='client'?'selected':''}>Client</option><option value="consultant" ${user?.role==='consultant'?'selected':''}>Consultant</option><option value="admin" ${user?.role==='admin'?'selected':''}>Admin</option></select></div><div class="field"><label>Company / Organization</label><input id="managedCompany" value="${esc(user?.company || '')}"></div><div class="field"><label>Contact Number</label><input id="managedContact" value="${esc(user?.contact || '')}"></div><div class="field"><label>${user?'New Password (optional)':'Temporary Password *'}</label><input id="managedPassword" type="password" minlength="8" ${user?'':'required'} autocomplete="new-password" placeholder="At least 8 characters"></div></div><div class="actions"><button type="button" class="btn gray" onclick="closeM()">Cancel</button><button class="btn primary">${user?'Save Changes':'Create Secure Account'}</button></div></form>`);
  };

  window.secureSaveManagedUser = async function secureSaveManagedUser(event, id) {
    event.preventDefault();
    const payload = {
      action: id ? 'update' : 'create',
      user_id: id || undefined,
      email: managedEmail.value.trim().toLowerCase(),
      password: managedPassword.value || undefined,
      name: managedName.value.trim(),
      company: managedCompany.value.trim(),
      contact: managedContact.value.trim(),
      role: managedRole.value
    };
    const submit = event.submitter;
    if (submit) submit.disabled = true;
    try {
      const {error} = await portalSupabase.functions.invoke('manage-user', {body:payload});
      if (error) throw error;
      await loadProfiles();
      closeM();render();alert(id ? 'User updated securely.' : 'Secure user account created.');
    } catch (error) {
      alert(await edgeError(error));
    } finally {
      if (submit) submit.disabled = false;
    }
  };

  window.toggleUser = async function secureToggleUser(id) {
    if (current?.role !== 'admin') return;
    const user = users.find(item => item.id === id);
    if (!user) return;
    const next = !user.active;
    if (!confirm(`${next ? 'Activate' : 'Deactivate'} ${user.name || user.email}?`)) return;
    try {
      const {error} = await portalSupabase.functions.invoke('manage-user', {body:{action:'update',user_id:id,active:next}});
      if (error) throw error;
      await loadProfiles();render();
    } catch (error) {
      alert(await edgeError(error));
    }
  };

  window.secureSubmitPayment = async function secureSubmitPayment(payment, file) {
    if (!current || current.role !== 'client' || !UUID_RE.test(String(current.id || ''))) {
      throw new Error('Only a signed-in client can submit a payment.');
    }
    if (!file || !PAYMENT_PROOF_EXTENSIONS.has(file.type)) {
      throw new Error('Please upload a JPEG, PNG, or WebP payment proof.');
    }
    if (file.size > PAYMENT_PROOF_MAX_BYTES) {
      throw new Error('The payment proof must be 5 MB or smaller.');
    }
    const paymentId = String(payment?.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
    if (!paymentId) throw new Error('The payment record could not be prepared.');
    const extension = PAYMENT_PROOF_EXTENSIONS.get(file.type);
    const proofPath = `${current.id}/${paymentId}-${Date.now()}.${extension}`;
    const {data:uploaded, error:uploadError} = await portalSupabase.storage
      .from(PAYMENT_PROOF_BUCKET)
      .upload(proofPath, file, {contentType:file.type, cacheControl:'3600', upsert:false});
    if (uploadError) throw new Error(`Proof upload failed: ${uploadError.message}`);

    const stored = {
      ...payment,
      id: paymentId,
      clientId: current.id,
      ownerId: current.id,
      clientEmail: current.email,
      clientName: current.name || payment.clientName || 'Client',
      company: current.company || payment.company || '',
      proofPath: uploaded.path,
      proofFileName: String(file.name || 'payment-proof').slice(0, 180),
      proofMimeType: file.type,
      proofSize: file.size,
      proofUploadedAt: new Date().toISOString()
    };
    const row = {
      id: paymentId,
      record_type: 'payments',
      owner_id: current.id,
      company: stored.company,
      data: stored,
      updated_at: new Date().toISOString()
    };
    const {error:recordError} = await portalSupabase
      .from('portal_records')
      .upsert(row, {onConflict:'id,record_type'});
    if (recordError) {
      await portalSupabase.storage.from(PAYMENT_PROOF_BUCKET).remove([uploaded.path]).catch(() => {});
      throw new Error(`Payment record failed: ${recordError.message}`);
    }
    const key = recordKey('payments', paymentId);
    recordOwners.set(key, current.id);
    recordSnapshot.set(key, JSON.stringify(stored));
    return stored;
  };

  window.secureViewPaymentProof = async function secureViewPaymentProof(path, label='Payment Proof') {
    const proofPath = String(path || '');
    if (!proofPath || proofPath.includes('..')) return alert('This payment proof is unavailable.');
    try {
      const {data, error} = await portalSupabase.storage
        .from(PAYMENT_PROOF_BUCKET)
        .createSignedUrl(proofPath, 300);
      if (error || !data?.signedUrl) throw error || new Error('Signed proof link was not created.');
      modal('Payment Proof', `<div class="form proof-viewer"><h3 style="margin-top:0">${esc(label)}</h3><img src="${esc(data.signedUrl)}" alt="Payment proof"><a class="btn primary" href="${esc(data.signedUrl)}" target="_blank" rel="noopener noreferrer">Open Full Size</a><button type="button" class="btn gray" style="margin-left:8px" onclick="closeM()">Close</button><div class="small" style="margin-top:12px">Private viewing link expires in 5 minutes.</div></div>`);
    } catch (error) {
      console.error(error);
      alert(error?.message || 'The payment proof could not be opened.');
    }
  };

  window.securePortalBootstrap = async function securePortalBootstrap() {
    if (!window.supabase?.createClient) {
      cloudStatus('error', 'Security library failed to load');
      return alert('The secure login library could not load. Check your internet connection and refresh the page.');
    }
    if (!window.portalSupabase) {
      window.portalSupabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,flowType:'implicit',storageKey:'1020-portal-auth'}
      });
    }
    if (!authListener) {
      const {data} = portalSupabase.auth.onAuthStateChange((event) => {
        setTimeout(async () => {
          if (event === 'PASSWORD_RECOVERY') return showRecovery();
          if (event === 'SIGNED_OUT') {
            clearPortalMemory();
            if (!recoveryMode) window.secureShowLogin();
          }
          if (event === 'SIGNED_IN' && !current && !recoveryMode) await window.secureCloudLoad();
        }, 0);
      });
      authListener = data.subscription;
    }
    if (authRedirectErrorCode) {
      recoveryMode = false;
      window.secureShowForgot();
      const message = authRedirectErrorCode === 'otp_expired'
        ? 'This password-reset link is expired or has already been used. Request a new link below, then open only the newest email link once.'
        : (authRedirectErrorDescription || 'This password-reset link is invalid. Please request a new link below.');
      resultBox('forgotResult','bad',message);
      history.replaceState({}, document.title, location.pathname);
      cloudStatus('', 'Request a new password-reset link');
      return;
    }
    if (recoveryMode) {
      showRecovery();
      return;
    }
    const {data:{session}} = await portalSupabase.auth.getSession();
    if (session) await window.secureCloudLoad();
    else {
      clearPortalMemory();
      window.secureShowLogin();
      cloudStatus('', 'Sign in to connect');
    }
  };
})();
