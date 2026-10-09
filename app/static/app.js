let token = localStorage.getItem('campusflow_token');
let offlineMode = false;
let offlineSetupIssue = '';
let syncInProgress = false;
let dashboardLoaded = false;
let routineLoaded = false;
let notesLoaded = false;
const OFFLINE_EMAIL_KEY = 'campusflow_offline_email';
let authMode = 'login';
let courses = [];
let tasks = [];
let scheduleEntries = [];
let scheduleDraft = [];
let editingTaskId = null;
let addingGradeTo = null;
let editingGradeId = null;
let currentUserId = null;
let studyDocuments = [];
let studyNotes = [];
let activeConversationEmail = '';
let activeConversationUserId = null;
let activePageId = 'homePage';
let assistantAnswer = '';
let conversationSignature = '';
let contactUnreadCounts = new Map();
let messageSoundSessionStartedAt = Date.now();
let notificationAudioContext = null;
let pdfReaderObjectUrls = new Map();
let pdfReaderDocumentId = null;
let pdfReaderPageCount = 0;
let pdfReaderRequest = 0;
let pdfReaderObserver = null;
let pdfReaderCurrentPage = 1;
let realtimeSocket = null;
let realtimeReconnectTimer = null;
let realtimeHeartbeatTimer = null;
let realtimeIceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
let currentCall = null;
let callTimeoutTimer = null;
let voiceRecorder = null;
let voiceRecordingStream = null;
let voiceRecordingTimer = null;
let voiceRecordingSeconds = 0;
let pendingVoiceFile = null;
let voicePreviewUrl = null;
const audioMessageUrls = new Set();
let routineOverview = null;
let focusTimerState = null;
let focusTimerInterval = null;
let selectedFocusMinutes = 25;
const priorityNames = { 1: 'Düşük', 2: 'Az öncelikli', 3: 'Normal', 4: 'Öncelikli', 5: 'Acil' };
const statusNames = { todo: 'Yapılacak', in_progress: 'Devam ediyor', done: 'Tamamlandı' };
const $ = id => document.getElementById(id);

async function requestOnlineApi(path, options = {}) {
  const isFormData = options.body instanceof FormData;
  const headers = { ...(options.body && !isFormData ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try { response = await fetch(path, { ...options, headers }); }
  catch {
    const error = new Error('Sunucu bağlantısı kurulamadı. Bu istek çevrimiçi kullanım gerektiriyor.');
    error.network = true;
    throw error;
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const detail = data.detail;
    const error = new Error(Array.isArray(detail) ? detail.map(item => item.msg).join(', ') : detail || 'İşlem başarısız.');
    error.status = response.status;
    if ([502, 503, 504].includes(response.status)) error.network = true;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

async function api(path, options = {}) {
  const offline = window.CampusFlowOffline;
  const authRequest = path === '/api/auth/login' || path === '/api/auth/register';
  const localPreferred = !authRequest && (offlineMode || navigator.onLine === false);
  if (localPreferred && offline?.ready) {
    try {
      const result = await offline.api(path, options);
      updateConnectionBanner();
      return result;
    }
    catch (error) {
      if (!error.requiresInternet || navigator.onLine === false) throw error;
    }
  }
  if (navigator.onLine === false && authRequest) {
    const error = new Error('Sunucuya ulaşılamıyor; kayıtlı hesabını bu cihazda çevrimdışı açmayı deneyebilirsin.');
    error.network = true;
    throw error;
  }
  if (navigator.onLine === false && offline?.ready) {
    const result = await offline.api(path, options);
    updateConnectionBanner();
    return result;
  }
  if (navigator.onLine === false) throw new Error('Bu özellik internet bağlantısı gerektiriyor. Bağlantı geldiğinde yeniden dene.');

  try { return await requestOnlineApi(path, options); }
  catch (error) {
    if (!error.network) throw error;
    if (authRequest) throw error;
    if (offline?.ready) {
      activateOfflineMode();
      updateConnectionBanner();
      try {
        const result = await offline.api(path, options);
        updateConnectionBanner();
        return result;
      }
      catch (localError) {
        if (localError.requiresInternet) throw localError;
        throw error;
      }
    }
    if ($('app') && !$('app').hidden) promptOfflineLogin();
    throw new Error('Bağlantı kesildi. Bu cihazdaki kayıtlı hesabı açmak için e-posta ve şifreni gir.');
  }
}

function activateOfflineMode() {
  offlineMode = true;
  if (realtimeReconnectTimer) clearTimeout(realtimeReconnectTimer);
  if (realtimeHeartbeatTimer) clearInterval(realtimeHeartbeatTimer);
  realtimeReconnectTimer = null;
  realtimeHeartbeatTimer = null;
  if (currentCall) finishLocalCall();
  const socket = realtimeSocket;
  realtimeSocket = null;
  socket?.close();
}

function updateConnectionBanner(message = '') {
  const banner = $('connectionBanner');
  if (!banner) return;
  const pending = window.CampusFlowOffline?.pendingCount || 0;
  const isOffline = navigator.onLine === false || (offlineMode && pending === 0);
  const notice = message || (isOffline
    ? `Çevrimdışısın. Ders, görev, program, çalışma kaydı ve notların bu cihazdaki şifreli kopyadan kullanılabilir.${pending ? ` ${pending} değişiklik eşitlenmeyi bekliyor.` : ''}`
    : pending
      ? `${pending} değişiklik bu cihazda bekliyor; bağlantı gelince eşitle.`
      : offlineSetupIssue);
  banner.hidden = !notice;
  banner.classList.toggle('is-error', Boolean(isOffline || offlineSetupIssue || message));
  banner.classList.toggle('is-good', !isOffline && !pending && !offlineSetupIssue && Boolean(notice));
  $('connectionMessage').textContent = notice;
  $('syncOfflineData').hidden = !pending && !isOffline;
  $('syncOfflineData').disabled = navigator.onLine === false || !localStorage.getItem('campusflow_token');
}

function promptOfflineLogin(message = '') {
  token = null;
  currentUserId = null;
  if (focusTimerInterval) clearInterval(focusTimerInterval);
  focusTimerInterval = null;
  focusTimerState = null;
  if (realtimeReconnectTimer) clearTimeout(realtimeReconnectTimer);
  if (realtimeHeartbeatTimer) clearInterval(realtimeHeartbeatTimer);
  if (currentCall) finishLocalCall();
  realtimeSocket?.close();
  realtimeSocket = null;
  $('userArea').replaceChildren();
  $('app').hidden = true;
  $('assistantLauncher').hidden = true;
  $('assistantPanel').hidden = true;
  $('auth').hidden = false;
  resetLoadedWorkspace();
  $('email').value ||= localStorage.getItem(OFFLINE_EMAIL_KEY) || '';
  setAuthMode('login');
  $('authMsg').textContent = message || 'İnternet bağlantısı yok. Bu cihazda daha önce giriş yaptıysan e-posta ve şifrenle çevrimdışı açabilirsin.';
}

function resetLoadedWorkspace() {
  courses = [];
  tasks = [];
  scheduleEntries = [];
  scheduleDraft = [];
  routineOverview = null;
  studyNotes = [];
  dashboardLoaded = false;
  routineLoaded = false;
  notesLoaded = false;
}

async function syncOfflineData() {
  const offline = window.CampusFlowOffline;
  if (navigator.onLine === false) {
    updateConnectionBanner('Eşitlemek için internet bağlantısı gerekiyor. Çevrimdışı değişikliklerin bu cihazda korunuyor.');
    return;
  }
  const savedToken = localStorage.getItem('campusflow_token');
  if (!savedToken || !offline?.ready) {
    updateConnectionBanner('Eşitlemek için internet açıkken hesabına yeniden giriş yap. Bu cihazdaki kayıtların korunuyor.');
    return;
  }
  if (syncInProgress) return;
  syncInProgress = true;
  token = savedToken;
  try {
    await requestOnlineApi('/api/auth/me');
    const result = await offline.syncPending(token);
    offlineMode = false;
    offlineSetupIssue = '';
    updateConnectionBanner(result.synced ? `${result.synced} değişiklik eşitlendi.` : 'Verilerin güncel.');
    await loadDashboard();
    await loadRoutine();
    await loadNotes();
    connectRealtime();
    checkAdminStatus();
    loadContacts();
    setTimeout(() => updateConnectionBanner(), 3500);
  } catch (error) {
    activateOfflineMode();
    const message = [401, 403].includes(error.status)
      ? 'Bu cihazdaki değişiklikleri eşitlemek için internet açıkken hesabına yeniden giriş yap. Kayıtların bu cihazda korunuyor.'
      : error.message || 'Eşitleme tamamlanamadı. Kayıtların bu cihazda korunuyor.';
    if ([401, 403].includes(error.status)) {
      token = null;
      localStorage.removeItem('campusflow_token');
    }
    updateConnectionBanner(message);
  } finally { syncInProgress = false; }
}

async function saveOfflineSnapshot(extra = {}) {
  const offline = window.CampusFlowOffline;
  if (!offline?.ready) return;
  try {
    const snapshot = { user: offline.user };
    if (dashboardLoaded) Object.assign(snapshot, {
      courses: courses.map(course => ({ ...course, grades: course.grades || [] })),
      tasks: [...tasks],
      schedule: [...scheduleEntries],
    });
    if (routineLoaded) snapshot.routine = routineOverview;
    if (notesLoaded) snapshot.notes = [...studyNotes];
    offline.setSnapshot({ ...snapshot, ...extra });
    await offline.persist().catch(error => {
      offlineSetupIssue = `Çevrimdışı kopya güncellenemedi: ${error.message}`;
      updateConnectionBanner();
    });
  } catch (error) {
    offlineSetupIssue = `Çevrimdışı kopya güncellenemedi: ${error.message}`;
    updateConnectionBanner();
  }
}

function authErrorMessage(error, registering, accountCreated) {
  if (accountCreated) return 'Hesabın oluşturuldu ancak otomatik giriş tamamlanamadı. Giriş yap bölümünden devam edebilirsin.';
  if (error.status === 409) return 'Bu e-posta adresi zaten kayıtlı. Giriş yapabilir veya farklı bir e-posta kullanabilirsin.';
  if (error.status === 422) return registering
    ? 'Bilgileri kontrol et: geçerli bir e-posta, en az 2 karakterli ad soyad ve en az 8 karakterli şifre gerekli.'
    : 'E-posta biçimini ve şifreni kontrol et.';
  if (error.status === 401) return 'E-posta veya şifre hatalı.';
  if (error.status >= 500) return 'Sunucuda bir sorun oluştu. Biraz sonra yeniden dene.';
  return error.message;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function unlockNotificationAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  try {
    notificationAudioContext ||= new AudioContextClass();
    if (notificationAudioContext.state === 'suspended') notificationAudioContext.resume().catch(() => {});
  } catch {}
}

document.addEventListener('pointerdown', unlockNotificationAudio, { once: true });
document.addEventListener('keydown', unlockNotificationAudio, { once: true });

function playMessageNotification(kind) {
  const context = notificationAudioContext;
  if (!context) return;
  const play = () => {
    if (context.state !== 'running') return;
    const notes = kind === 'sent' ? [587.33, 783.99] : [659.25, 830.61, 987.77];
    const now = context.currentTime + 0.015;
    notes.forEach((frequency, index) => {
      const start = now + index * 0.105;
      const duration = kind === 'sent' ? 0.13 : 0.16;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(kind === 'sent' ? 0.075 : 0.09, start + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + duration + 0.01);
    });
  };
  if (context.state === 'suspended') context.resume().then(play).catch(() => {});
  else play();
}

function isOverdue(task) {
  return Boolean(task.due_at && task.status !== 'done' && new Date(task.due_at) < new Date());
}

function formatDueDate(value) {
  if (!value) return 'Tarih belirlenmedi';
  const date = new Date(value);
  const day = date.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
  const time = date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  return `${day} · ${time}`;
}

function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === 'register';
  $('authTitle').textContent = registering ? 'Yeni hesap oluştur' : 'Hoş geldin 👋';
  $('authHint').textContent = registering
    ? 'Derslerini, notlarını ve teslim tarihlerini tek yerde takip et.'
    : 'Derslerini, notlarını ve teslim tarihlerini tek yerde takip et. Bu cihazda bir kez giriş yaptıktan sonra temel planını çevrimdışı da açabilirsin.';
  $('nameLabel').hidden = !registering;
  $('name').required = registering;
  $('password').autocomplete = registering ? 'new-password' : 'current-password';
  $('authSubmit').textContent = registering ? 'Hesap oluştur' : 'Giriş yap';
  $('authSwitch').textContent = registering ? 'Zaten hesabım var' : 'Yeni hesap oluştur';
  $('authMsg').textContent = '';
  $('authMsg').className = '';
}

function setLoggedIn(user) {
  currentUserId = user.id;
  contactUnreadCounts.clear();
  messageSoundSessionStartedAt = Date.now();
  $('auth').hidden = true;
  $('app').hidden = false;
  $('assistantLauncher').hidden = false;
  $('portalUrl').value = localStorage.getItem(`campusflow_portal_${user.id}`) || '';
  $('welcomeTitle').textContent = `Merhaba, ${user.full_name.split(' ')[0]}`;
  $('todayDate').textContent = new Date().toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('userArea').innerHTML = `<span class="welcome">${escapeHtml(user.full_name)}</span><button class="secondary" id="logout">Çıkış yap</button>`;
  restoreFocusTimer();
  $('logout').onclick = logout;
  updateConnectionBanner();
  if (!offlineMode) {
    connectRealtime();
    checkAdminStatus();
    loadContacts();
  }
}

function logout() {
  if (focusTimerInterval) clearInterval(focusTimerInterval);
  focusTimerInterval = null;
  focusTimerState = null;
  token = null;
  offlineMode = false;
  window.CampusFlowOffline?.lock();
  currentUserId = null;
  resetLoadedWorkspace();
  activeConversationEmail = '';
  conversationSignature = '';
  contactUnreadCounts.clear();
  stopVoiceRecording(false);
  resetVoicePreview();
  finishLocalCall();
  if (realtimeReconnectTimer) clearTimeout(realtimeReconnectTimer);
  if (realtimeHeartbeatTimer) clearInterval(realtimeHeartbeatTimer);
  realtimeReconnectTimer = null;
  realtimeHeartbeatTimer = null;
  realtimeSocket?.close();
  realtimeSocket = null;
  activeConversationUserId = null;
  activePageId = 'homePage';
  $('adminNav').hidden = true;
  revokeAudioMessageUrls();
  localStorage.removeItem('campusflow_token');
  $('userArea').replaceChildren();
  $('app').hidden = true;
  $('assistantLauncher').hidden = true;
  $('assistantPanel').hidden = true;
  $('auth').hidden = false;
  $('loginForm').reset();
  setAuthMode('login');
  updateConnectionBanner();
}

function setPage(pageId) {
  if (pageId === 'adminPage' && $('adminNav').hidden) return;
  const internetPages = new Set(['studyPage', 'messagesPage', 'aiSettingsPage', 'adminPage']);
  if (internetPages.has(pageId) && navigator.onLine === false) {
    const pageNames = { studyPage: 'Ders materyalleri ve PDF işleme', messagesPage: 'Mesajlaşma', aiSettingsPage: 'AI ayarları', adminPage: 'Yönetici paneli' };
    updateConnectionBanner(`${pageNames[pageId]} internet bağlantısı gerektiriyor. Diğer bölümler çevrimdışı kullanılabilir.`);
    return;
  }
  activePageId = pageId;
  document.querySelectorAll('.workspace-page').forEach(page => { page.hidden = page.id !== pageId; });
  document.querySelectorAll('.nav-tab').forEach(button => button.classList.toggle('active', button.dataset.page === pageId));
  if (pageId === 'studyPage') loadDocuments();
  if (pageId === 'notesPage') loadNotes();
  if (pageId === 'messagesPage') loadContacts();
  if (pageId === 'aiSettingsPage') loadAISettings();
  if (pageId === 'routinePage') loadRoutine();
  if (pageId === 'adminPage') loadActiveUsers();
  realtimeSocket?.readyState === WebSocket.OPEN && realtimeSocket.send(JSON.stringify({ type: 'heartbeat', page: activePageId }));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function connectRealtime() {
  if (!token || offlineMode || navigator.onLine === false || (realtimeSocket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(realtimeSocket.readyState))) return;
  if (realtimeReconnectTimer) clearTimeout(realtimeReconnectTimer);
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/api/realtime`);
  realtimeSocket = socket;
  socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', token, page: activePageId }));
  socket.onmessage = event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    handleRealtimeEvent(message);
  };
  socket.onclose = () => {
    if (realtimeSocket !== socket) return;
    realtimeSocket = null;
    if (realtimeHeartbeatTimer) clearInterval(realtimeHeartbeatTimer);
    realtimeHeartbeatTimer = null;
    if (currentCall) finishLocalCall();
    if (token && !offlineMode && navigator.onLine !== false) realtimeReconnectTimer = setTimeout(connectRealtime, 2000);
  };
}

function sendRealtime(payload) {
  if (!realtimeSocket || realtimeSocket.readyState !== WebSocket.OPEN) return false;
  realtimeSocket.send(JSON.stringify(payload));
  return true;
}

async function checkAdminStatus() {
  try {
    const result = await api('/api/admin/status');
    $('adminNav').hidden = !result.is_admin;
    if (!result.is_admin && activePageId === 'adminPage') setPage('homePage');
  } catch {
    $('adminNav').hidden = true;
  }
}

const activePageNames = {
  homePage: 'Dönemim', routinePage: 'Çalışma düzenim', studyPage: 'Ders materyalleri',
  notesPage: 'AI notlarım', messagesPage: 'Mesajlar', aiSettingsPage: 'AI ayarları', adminPage: 'Yönetici paneli',
};

async function loadActiveUsers() {
  if ($('adminNav').hidden) return;
  try {
    const result = await api('/api/admin/active-users');
    $('onlineCount').textContent = `${result.online_count} ${result.online_count === 1 ? 'kişi' : 'kişi'} çevrimiçi`;
    $('activeUserList').innerHTML = result.users.length ? result.users.map(user => {
      const seen = user.last_seen ? new Date(user.last_seen).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
      return `<article class="active-user-card"><span class="presence-pulse"></span><div class="active-user-main"><strong>${escapeHtml(user.full_name)}</strong><small>${escapeHtml(user.email)}</small></div><div class="active-user-meta"><strong>${escapeHtml(activePageNames[user.page] || 'Uygulamada')}</strong><small>Son etkinlik ${escapeHtml(seen)} · ${user.session_count} oturum</small></div></article>`;
    }).join('') : '<div class="empty"><strong>Şu an çevrimiçi kullanıcı yok.</strong><span>Bu listeye yalnızca aktif CampusFlow bağlantıları dahil edilir.</span></div>';
  } catch (error) {
    $('activeUserList').innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
  }
}

function handleRealtimeEvent(message) {
  if (message.type === 'ready') {
    realtimeIceServers = Array.isArray(message.ice_servers) && message.ice_servers.length ? message.ice_servers : realtimeIceServers;
    if (realtimeHeartbeatTimer) clearInterval(realtimeHeartbeatTimer);
    realtimeHeartbeatTimer = setInterval(() => sendRealtime({ type: 'heartbeat', page: activePageId }), 10000);
    return;
  }
  if (message.type === 'call_incoming') {
    if (currentCall) {
      sendRealtime({ type: 'call_reject', call_id: message.call_id });
      return;
    }
    currentCall = { id: message.call_id, media: message.media, initiator: false, remote: message.caller, stream: null, peer: null, pendingCandidates: [] };
    $('callTitle').textContent = `${message.caller.full_name} arıyor`;
    $('callStatus').textContent = message.media === 'video' ? 'Görüntülü arama isteği' : 'Sesli arama isteği';
    $('callVideoStage').hidden = message.media !== 'video';
    $('incomingCallActions').hidden = false;
    $('activeCallActions').hidden = true;
    $('toggleCamera').hidden = message.media !== 'video';
    showCallDialog();
  } else if (message.type === 'call_ringing') {
    if (!currentCall || !currentCall.initiator) {
      sendRealtime({ type: 'call_end', call_id: message.call_id });
      return;
    }
    currentCall.id = message.call_id;
    $('callStatus').textContent = 'Karşı tarafın yanıtı bekleniyor…';
    if (callTimeoutTimer) clearTimeout(callTimeoutTimer);
    callTimeoutTimer = setTimeout(() => {
      if (currentCall?.id !== message.call_id) return;
      sendRealtime({ type: 'call_end', call_id: message.call_id });
      finishLocalCall();
      $('conversationHint').textContent = 'Yanıt gelmedi. Daha sonra yeniden arayabilirsin.';
    }, 45000);
  } else if (message.type === 'call_accepted') {
    if (!currentCall || currentCall.id !== message.call_id) return;
    if (!currentCall.initiator && !currentCall.stream) {
      finishLocalCall();
      return;
    }
    if (callTimeoutTimer) clearTimeout(callTimeoutTimer);
    callTimeoutTimer = null;
    $('incomingCallActions').hidden = true;
    $('activeCallActions').hidden = false;
    $('callStatus').textContent = 'Bağlanıyor…';
    if (currentCall.initiator) createPeerConnection().then(async peer => {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      sendRealtime({ type: 'rtc_offer', call_id: currentCall.id, payload: offer });
    }).catch(showCallError);
  } else if (message.type === 'rtc_offer') {
    if (!currentCall || currentCall.id !== message.call_id || currentCall.initiator) return;
    handleRtcOffer(message.payload).catch(showCallError);
  } else if (message.type === 'rtc_answer') {
    if (!currentCall || currentCall.id !== message.call_id || !currentCall.peer) return;
    currentCall.peer.setRemoteDescription(message.payload).then(applyPendingCandidates).catch(showCallError);
  } else if (message.type === 'rtc_ice') {
    if (!currentCall || currentCall.id !== message.call_id || !message.payload) return;
    if (!currentCall.peer?.remoteDescription) currentCall.pendingCandidates.push(message.payload);
    else currentCall.peer.addIceCandidate(message.payload).catch(showCallError);
  } else if (['call_rejected', 'call_ended'].includes(message.type)) {
    if (currentCall?.id === message.call_id) {
      const wasDeclined = message.type === 'call_rejected' || message.reason === 'declined';
      finishLocalCall();
      $('conversationHint').textContent = wasDeclined ? 'Arama reddedildi.' : 'Arama sona erdi.';
    }
  } else if (message.type === 'call_error') {
    if (currentCall && currentCall.id === null) {
      const text = message.message || 'Arama başlatılamadı.';
      finishLocalCall();
      $('conversationHint').textContent = text;
    } else showCallError(new Error(message.message || 'Arama sırasında bir sorun oluştu.'));
  }
}

function showCallDialog() {
  if (!$('callDialog').open) $('callDialog').showModal();
}

async function startCall(media) {
  if (!activeConversationUserId || !activeConversationEmail) return alert('Önce bir sohbet aç.');
  if (!realtimeSocket || realtimeSocket.readyState !== WebSocket.OPEN) return alert('Canlı bağlantı kuruluyor. Birkaç saniye sonra yeniden dene.');
  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) return alert('Bu tarayıcı sesli/görüntülü aramayı desteklemiyor. HTTPS bağlantısı ve güncel tarayıcı gerekir.');
  if (currentCall) return alert('Önce açık aramayı bitir.');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: media === 'video' ? { facingMode: 'user' } : false });
    currentCall = { id: null, media, initiator: true, remote: { full_name: activeConversationEmail }, stream, peer: null, pendingCandidates: [] };
    $('callTitle').textContent = `${media === 'video' ? 'Görüntülü' : 'Sesli'} arama`;
    $('callStatus').textContent = 'Aranıyor…';
    $('callVideoStage').hidden = media !== 'video';
    $('incomingCallActions').hidden = true;
    $('activeCallActions').hidden = false;
    $('toggleCamera').hidden = media !== 'video';
    $('localVideo').srcObject = stream;
    showCallDialog();
    if (!sendRealtime({ type: 'call_start', to_user_id: activeConversationUserId, media })) throw new Error('Canlı bağlantı koptu. Yeniden bağlanıp tekrar dene.');
  } catch (error) {
    finishLocalCall();
    alert(error.message || 'Mikrofon veya kamera açılamadı. Tarayıcı izinlerini kontrol et.');
  }
}

async function createPeerConnection() {
  if (!currentCall) throw new Error('Arama kapandı.');
  if (currentCall.peer) return currentCall.peer;
  const peer = new RTCPeerConnection({ iceServers: realtimeIceServers });
  currentCall.peer = peer;
  currentCall.stream?.getTracks().forEach(track => peer.addTrack(track, currentCall.stream));
  peer.onicecandidate = event => {
    if (event.candidate && currentCall?.id) sendRealtime({ type: 'rtc_ice', call_id: currentCall.id, payload: event.candidate.toJSON() });
  };
  peer.ontrack = event => {
    const stream = event.streams[0];
    if (!stream) return;
    if (currentCall?.media === 'video') {
      $('remoteVideo').srcObject = stream;
      $('remoteVideo').play().catch(() => { $('callStatus').textContent = 'Görüşmeyi başlatmak için ekrana dokun.'; });
    } else {
      $('remoteAudio').srcObject = stream;
      $('remoteAudio').play().catch(() => { $('callStatus').textContent = 'Sesi açmak için ekrana dokun.'; });
    }
  };
  peer.onconnectionstatechange = () => {
    if (!currentCall || currentCall.peer !== peer) return;
    if (peer.connectionState === 'connected') $('callStatus').textContent = 'Görüşme sürüyor';
    else if (peer.connectionState === 'disconnected') $('callStatus').textContent = 'Bağlantı yeniden kuruluyor…';
    else if (peer.connectionState === 'failed') $('callStatus').textContent = 'Bağlantı kurulamadı. Ağınız arama bağlantısını engelliyor olabilir.';
  };
  return peer;
}

async function handleRtcOffer(offer) {
  const peer = await createPeerConnection();
  await peer.setRemoteDescription(offer);
  await applyPendingCandidates();
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  sendRealtime({ type: 'rtc_answer', call_id: currentCall.id, payload: answer });
}

async function applyPendingCandidates() {
  if (!currentCall?.peer?.remoteDescription) return;
  const candidates = currentCall.pendingCandidates.splice(0);
  for (const candidate of candidates) await currentCall.peer.addIceCandidate(candidate);
}

async function acceptIncomingCall() {
  if (!currentCall || currentCall.initiator) return;
  try {
    currentCall.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: currentCall.media === 'video' ? { facingMode: 'user' } : false });
    $('localVideo').srcObject = currentCall.stream;
    await createPeerConnection();
    $('callStatus').textContent = 'Karşı tarafa bağlanıyor…';
    $('incomingCallActions').hidden = true;
    $('activeCallActions').hidden = false;
    sendRealtime({ type: 'call_accept', call_id: currentCall.id });
  } catch (error) {
    showCallError(new Error(error.message || 'Mikrofon/kamera izni verilmedi.'));
    sendRealtime({ type: 'call_reject', call_id: currentCall.id });
    finishLocalCall();
  }
}

function showCallError(error) {
  $('callStatus').textContent = error.message || 'Arama sırasında bir sorun oluştu.';
}

function finishLocalCall() {
  if (callTimeoutTimer) clearTimeout(callTimeoutTimer);
  callTimeoutTimer = null;
  const call = currentCall;
  currentCall = null;
  if (call?.peer) {
    call.peer.ontrack = null;
    call.peer.onicecandidate = null;
    call.peer.close();
  }
  call?.stream?.getTracks().forEach(track => track.stop());
  $('localVideo').srcObject = null;
  $('remoteVideo').srcObject = null;
  $('remoteAudio').srcObject = null;
  $('incomingCallActions').hidden = true;
  $('activeCallActions').hidden = true;
  $('toggleMicrophone').textContent = 'Mikrofonu kapat';
  $('toggleCamera').textContent = 'Kamerayı kapat';
  if ($('callDialog').open) $('callDialog').close();
}

function stopVoiceRecording(saveRecording = true) {
  if (voiceRecordingTimer) clearInterval(voiceRecordingTimer);
  voiceRecordingTimer = null;
  if (voiceRecorder && voiceRecorder.state !== 'inactive') {
    voiceRecorder.saveRecording = saveRecording;
    voiceRecorder.stop();
  } else {
    voiceRecordingStream?.getTracks().forEach(track => track.stop());
    voiceRecordingStream = null;
  }
}

function resetVoicePreview() {
  if (voicePreviewUrl) URL.revokeObjectURL(voicePreviewUrl);
  voicePreviewUrl = null;
  const preview = $('voicePreview');
  if (preview) {
    preview.pause();
    preview.removeAttribute('src');
    preview.load();
    preview.hidden = true;
  }
}

async function toggleVoiceRecording() {
  if (voiceRecorder && voiceRecorder.state !== 'inactive') {
    stopVoiceRecording(true);
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return alert('Bu tarayıcı ses kaydını desteklemiyor.');
  try {
    $('messageFile').value = '';
    pendingVoiceFile = null;
    resetVoicePreview();
    $('removeVoice').hidden = true;
    $('attachmentName').textContent = '';
    voiceRecordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const types = [
      ['audio/webm;codecs=opus', 'webm'], ['audio/mp4', 'm4a'], ['audio/ogg;codecs=opus', 'ogg'], ['audio/webm', 'webm'],
    ];
    const supported = types.find(([type]) => MediaRecorder.isTypeSupported(type));
    voiceRecorder = supported ? new MediaRecorder(voiceRecordingStream, { mimeType: supported[0] }) : new MediaRecorder(voiceRecordingStream);
    const fallbackExtension = supported?.[1] || (voiceRecorder.mimeType.includes('mp4') ? 'm4a' : voiceRecorder.mimeType.includes('ogg') ? 'ogg' : 'webm');
    const mime = voiceRecorder.mimeType || supported?.[0] || 'audio/webm';
    const chunks = [];
    voiceRecordingSeconds = 0;
    voiceRecorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    voiceRecorder.onstop = () => {
      voiceRecordingStream?.getTracks().forEach(track => track.stop());
      voiceRecordingStream = null;
      const shouldSave = voiceRecorder?.saveRecording !== false;
    if (shouldSave && chunks.length) {
        const blob = new Blob(chunks, { type: mime });
        const extension = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : mime.includes('mpeg') ? 'mp3' : fallbackExtension;
        pendingVoiceFile = new File([blob], `sesli-mesaj-${Date.now()}.${extension}`, { type: mime });
        resetVoicePreview();
        voicePreviewUrl = URL.createObjectURL(blob);
        $('voicePreview').src = voicePreviewUrl;
        $('voicePreview').hidden = false;
        $('removeVoice').hidden = false;
        $('messageFile').value = '';
        $('attachmentName').textContent = `🎙 Sesli mesaj · ${Math.floor(voiceRecordingSeconds / 60)}:${String(voiceRecordingSeconds % 60).padStart(2, '0')}`;
        $('recordingStatus').textContent = 'Ses kaydı hazır. Göndermeden önce istersen kaldırıp yeniden kaydedebilirsin.';
      } else {
        resetVoicePreview();
        $('removeVoice').hidden = true;
        $('recordingStatus').textContent = 'Ses kaydı iptal edildi.';
      }
      voiceRecorder = null;
      $('recordVoice').textContent = '🎙 Ses kaydet';
      $('recordVoice').classList.remove('recording');
    };
    voiceRecorder.start(500);
    $('recordVoice').textContent = '■ Kaydı bitir';
    $('recordVoice').classList.add('recording');
    $('recordingStatus').textContent = 'Kayıt sürüyor · en fazla 3 dakika';
    voiceRecordingTimer = setInterval(() => {
      voiceRecordingSeconds += 1;
      $('recordingStatus').textContent = `Kayıt sürüyor · ${Math.floor(voiceRecordingSeconds / 60)}:${String(voiceRecordingSeconds % 60).padStart(2, '0')} / 3:00`;
      if (voiceRecordingSeconds >= 180) stopVoiceRecording(true);
    }, 1000);
  } catch (error) {
    voiceRecordingStream?.getTracks().forEach(track => track.stop());
    voiceRecordingStream = null;
    alert(error.message || 'Mikrofon açılamadı. Tarayıcı izinlerini kontrol et.');
  }
}

function revokeAudioMessageUrls() {
  audioMessageUrls.forEach(url => URL.revokeObjectURL(url));
  audioMessageUrls.clear();
}

function isAudioAttachment(filename) {
  return /\.(webm|m4a|mp3|ogg|wav|aac)$/i.test(filename || '');
}

async function loadProtectedAudio(button) {
  button.disabled = true;
  button.textContent = 'Ses yükleniyor…';
  try {
    const response = await fetch(`/api/messages/${button.dataset.audioMessage}/audio`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error('Sesli mesaj açılamadı.');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    audioMessageUrls.add(url);
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = url;
    button.replaceWith(audio);
    audio.play().catch(() => {});
  } catch (error) {
    button.disabled = false;
    button.textContent = `▶ Yeniden dene: ${button.dataset.fileName}`;
    $('conversationHint').textContent = error.message;
  }
}

setInterval(() => {
  if (token && !document.hidden && activePageId === 'adminPage') loadActiveUsers();
}, 5000);

function formatCreatedAt(value) {
  return new Date(value).toLocaleString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function displayDate(value) {
  return new Date(`${value}T12:00:00`).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
}

function populateRoutineCourseSelects() {
  const selects = ['focusCourse', 'quickSessionCourse', 'attendanceCourse'];
  for (const id of selects) {
    const select = $(id);
    const selectedValue = select.value;
    const emptyLabel = id === 'attendanceCourse' ? 'Ders seç' : 'Serbest çalışma';
    select.innerHTML = `<option value="">${emptyLabel}</option>${courses.map(course => `<option value="${course.id}">${escapeHtml(course.code)} · ${escapeHtml(course.name)}</option>`).join('')}`;
    if (selectedValue && courses.some(course => String(course.id) === selectedValue)) select.value = selectedValue;
  }
  if (focusTimerState?.courseId && courses.some(course => course.id === focusTimerState.courseId)) $('focusCourse').value = String(focusTimerState.courseId);
}

async function loadRoutine() {
  try {
    routineOverview = await api('/api/routine/overview');
    routineLoaded = true;
    populateRoutineCourseSelects();
    $('weeklyGoalInput').value = routineOverview.weekly_goal_minutes;
    if (!$('attendanceDate').value) $('attendanceDate').value = localDateString();
    renderRoutine();
    renderFocusTimer();
    await saveOfflineSnapshot({ routine: routineOverview });
  } catch (error) {
    $('attendanceCourseSummary').innerHTML = `<div class="routine-empty routine-message-error">${escapeHtml(error.message)}</div>`;
  }
}

function renderRoutine() {
  if (!routineOverview) return;
  const data = routineOverview;
  const goal = Math.max(1, data.weekly_goal_minutes);
  const percent = Math.min(100, Math.round((data.week_minutes / goal) * 100));
  $('routineWeekMinutes').textContent = `${data.week_minutes} dk`;
  $('routineTodayMinutes').textContent = `${data.today_minutes} dk`;
  $('routineStreak').textContent = `${data.streak_days} ${data.streak_days === 1 ? 'gün' : 'gün'}`;
  $('routineGoalPercent').textContent = `${percent}%`;
  $('routineGoalHint').textContent = `${goal} dk haftalık hedef`;
  $('routineRemaining').textContent = data.week_minutes >= goal ? 'Haftalık hedef tamamlandı ✓' : `${goal - data.week_minutes} dk kaldı`;
  $('weeklyProgressBar').firstElementChild.style.width = `${percent}%`;
  $('weeklyProgressLabel').textContent = `${data.week_minutes} / ${goal} dk · ${percent}%`;

  const dayNames = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];
  const values = dayNames.map((_, index) => data.week_by_day[Object.keys(data.week_by_day)[index]] || 0);
  const maxValue = Math.max(30, ...values);
  $('weekChart').innerHTML = dayNames.map((day, index) => `<div class="week-chart-column" title="${day}: ${values[index]} dakika"><span class="week-chart-value">${values[index] ? `${values[index]}′` : ''}</span><div class="week-chart-track"><span style="height:${values[index] ? Math.max(5, Math.round(values[index] / maxValue * 100)) : 0}%"></span></div><span class="week-chart-day">${day}</span></div>`).join('');

  $('attendanceCourseSummary').innerHTML = data.attendance_by_course.length ? data.attendance_by_course.map(item => {
    const absencePercent = item.allowed_absences ? Math.min(100, item.absent / item.allowed_absences * 100) : (item.absent ? 100 : 0);
    const status = item.risk ? 'Sınırda' : `${item.absent}/${item.allowed_absences} devamsızlık`;
    return `<article class="attendance-course-row ${item.risk ? 'attendance-risk' : ''}"><div class="attendance-course-main"><strong>${escapeHtml(item.course_code)} · ${escapeHtml(item.course_name)}</strong><small>${item.attended} katılım · ${item.excused} izinli · ${item.total} kayıt</small><div class="attendance-meter"><span style="width:${absencePercent}%"></span></div></div><span class="attendance-pill">${status}</span></article>`;
  }).join('') : '<div class="routine-empty">Derslerin burada görünmesi için önce Dönemim bölümünden ders ekle veya programını aktar.</div>';

  const statusLabels = { attended: 'Katıldım', absent: 'Katılmadım', excused: 'İzinli' };
  $('attendanceHistory').innerHTML = data.attendance_records.length ? data.attendance_records.map(item => `<article class="attendance-record-row"><div class="attendance-record-main"><strong>${escapeHtml(item.course_code)} · ${escapeHtml(item.course_name)}</strong><small>${displayDate(item.date)}${item.note ? ` · ${escapeHtml(item.note)}` : ''}</small></div><div class="attendance-record-actions"><span class="attendance-status ${item.status}">${statusLabels[item.status] || escapeHtml(item.status)}</span><button type="button" class="text-button" data-delete-attendance="${item.id}" aria-label="Yoklama kaydını sil">Sil</button></div></article>`).join('') : '<div class="routine-empty">Henüz yoklama kaydı yok.</div>';
  $('attendanceHistory').querySelectorAll('[data-delete-attendance]').forEach(button => button.onclick = async () => {
    if (!confirm('Bu yoklama kaydını silmek istiyor musun?')) return;
    try { await api(`/api/routine/attendance/${button.dataset.deleteAttendance}`, { method: 'DELETE' }); await loadRoutine(); }
    catch (error) { alert(error.message); }
  });

  $('focusSessionHistory').innerHTML = data.sessions.length ? data.sessions.map(item => `<article class="focus-session-row"><div class="focus-session-main"><strong>${escapeHtml(item.course_name || 'Serbest çalışma')}</strong><small>${displayDate(item.date)}${item.note ? ` · ${escapeHtml(item.note)}` : ''}</small></div><span class="focus-session-minutes">${item.duration_minutes} dk</span></article>`).join('') : '<div class="routine-empty">Henüz çalışma oturumu yok. Sayaçla başlayabilir veya süreni elle ekleyebilirsin.</div>';
}

function timerStorageKey() { return `campusflow_focus_timer_${currentUserId || 'guest'}`; }

function persistFocusTimer() {
  if (focusTimerState && currentUserId) localStorage.setItem(timerStorageKey(), JSON.stringify(focusTimerState));
  else if (currentUserId) localStorage.removeItem(timerStorageKey());
}

function restoreFocusTimer() {
  focusTimerState = null;
  selectedFocusMinutes = 25;
  if (focusTimerInterval) clearInterval(focusTimerInterval);
  focusTimerInterval = null;
  if (!currentUserId) return;
  try {
    const saved = localStorage.getItem(timerStorageKey());
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && Number.isInteger(parsed.initialSeconds) && Number.isInteger(parsed.durationMinutes) && parsed.initialSeconds >= 60 && parsed.initialSeconds <= 10800) {
        parsed.saving = false;
        focusTimerState = parsed;
        selectedFocusMinutes = parsed.durationMinutes;
        $('focusSessionNote').value = parsed.note || '';
      }
    }
  } catch { localStorage.removeItem(timerStorageKey()); }
  renderFocusTimer();
  if (focusTimerState?.running) {
    focusTimerInterval = setInterval(tickFocusTimer, 1000);
    tickFocusTimer();
  }
}

function remainingFocusSeconds() {
  if (!focusTimerState) return selectedFocusMinutes * 60;
  return focusTimerState.running
    ? Math.max(0, Math.ceil((focusTimerState.deadline - Date.now()) / 1000))
    : Math.max(0, focusTimerState.remainingSeconds);
}

function renderFocusTimer() {
  const remaining = remainingFocusSeconds();
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  $('focusTimerDisplay').textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  const total = focusTimerState?.initialSeconds || selectedFocusMinutes * 60;
  const elapsedPercent = focusTimerState ? Math.min(100, Math.max(0, (total - remaining) / total * 100)) : 0;
  $('focusTimerProgress').style.width = `${elapsedPercent}%`;
  $('startFocusTimer').disabled = Boolean(focusTimerState?.running || focusTimerState?.saving);
  $('pauseFocusTimer').disabled = !focusTimerState?.running || Boolean(focusTimerState?.saving);
  $('finishFocusTimer').disabled = !focusTimerState || Boolean(focusTimerState?.saving);
  $('focusCourse').disabled = Boolean(focusTimerState);
  document.querySelectorAll('[data-focus-minutes]').forEach(button => {
    button.disabled = Boolean(focusTimerState);
    button.classList.toggle('selected', Number(button.dataset.focusMinutes) === (focusTimerState?.durationMinutes || selectedFocusMinutes));
  });
  if (focusTimerState?.running) $('focusTimerStatus').textContent = 'Odaklanma sürüyor. İstersen duraklatabilir veya oturumu erken bitirebilirsin.';
  else if (focusTimerState) $('focusTimerStatus').textContent = remaining === 0 ? 'Süre doldu. Oturumunu kaydetmek için Bitir’e dokun.' : 'Sayaç duraklatıldı; kaldığın yerden devam edebilirsin.';
  else $('focusTimerStatus').textContent = 'Bir ders seç veya serbest çalışmaya başla.';
}

function tickFocusTimer() {
  if (!focusTimerState?.running) return;
  const remaining = remainingFocusSeconds();
  if (remaining <= 0) {
    clearInterval(focusTimerInterval);
    focusTimerInterval = null;
    focusTimerState.remainingSeconds = 0;
    focusTimerState.running = false;
    focusTimerState.deadline = null;
    focusTimerState.completed = true;
    persistFocusTimer();
    renderFocusTimer();
    saveTimedFocusSession(focusTimerState.durationMinutes);
    return;
  }
  renderFocusTimer();
}

async function saveTimedFocusSession(durationMinutes) {
  if (!focusTimerState || focusTimerState.saving) return;
  focusTimerState.saving = true;
  persistFocusTimer();
  renderFocusTimer();
  try {
    await api('/api/routine/sessions', { method: 'POST', body: JSON.stringify({ duration_minutes: durationMinutes, course_id: focusTimerState.courseId || null, note: $('focusSessionNote').value.trim() || null }) });
    focusTimerState = null;
    persistFocusTimer();
    $('focusSessionNote').value = '';
    $('focusTimerStatus').textContent = '✓ Çalışma oturumu kaydedildi.';
    await loadRoutine();
  } catch (error) {
    focusTimerState.saving = false;
    focusTimerState.running = false;
    focusTimerState.remainingSeconds = 0;
    persistFocusTimer();
    renderFocusTimer();
    $('focusTimerStatus').textContent = `Kaydedilemedi: ${error.message}. Yeniden denemek için Bitir’e dokun.`;
    $('focusTimerStatus').classList.add('routine-message-error');
  }
}

function startOrResumeFocusTimer() {
  if (focusTimerState?.running) return;
  if (!focusTimerState) {
    focusTimerState = {
      durationMinutes: selectedFocusMinutes,
      initialSeconds: selectedFocusMinutes * 60,
      remainingSeconds: selectedFocusMinutes * 60,
      courseId: $('focusCourse').value ? Number($('focusCourse').value) : null,
      note: $('focusSessionNote').value.trim(),
      running: true,
      deadline: Date.now() + selectedFocusMinutes * 60 * 1000,
    };
  } else {
    focusTimerState.note = $('focusSessionNote').value.trim();
    focusTimerState.running = true;
    focusTimerState.deadline = Date.now() + focusTimerState.remainingSeconds * 1000;
  }
  $('focusTimerStatus').classList.remove('routine-message-error');
  persistFocusTimer();
  renderFocusTimer();
  if (focusTimerInterval) clearInterval(focusTimerInterval);
  focusTimerInterval = setInterval(tickFocusTimer, 1000);
  tickFocusTimer();
}

function pauseFocusTimer() {
  if (!focusTimerState?.running) return;
  focusTimerState.remainingSeconds = remainingFocusSeconds();
  focusTimerState.running = false;
  focusTimerState.deadline = null;
  if (focusTimerInterval) clearInterval(focusTimerInterval);
  focusTimerInterval = null;
  persistFocusTimer();
  renderFocusTimer();
}

function finishFocusTimer() {
  if (!focusTimerState) return;
  if (focusTimerState.completed || remainingFocusSeconds() === 0) {
    saveTimedFocusSession(focusTimerState.durationMinutes);
    return;
  }
  const elapsedMinutes = Math.floor((focusTimerState.initialSeconds - remainingFocusSeconds()) / 60);
  if (elapsedMinutes < 1) {
    $('focusTimerStatus').textContent = 'Kaydetmek için en az 1 dakika çalışmış olmalısın.';
    $('focusTimerStatus').classList.add('routine-message-error');
    return;
  }
  pauseFocusTimer();
  saveTimedFocusSession(elapsedMinutes);
}

async function loadDocuments() {
  try {
    studyDocuments = await api('/api/study/documents');
    renderDocuments();
  } catch (error) { $('documentList').innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`; }
}

function renderDocuments() {
  $('documentList').innerHTML = studyDocuments.length ? studyDocuments.map(document => `<article class="document-card">
    <div class="document-card-header"><div><span class="course-code">PDF · DERS MATERYALİ</span><h3>${escapeHtml(document.title)}</h3><small>${escapeHtml(document.filename)} · ${formatCreatedAt(document.created_at)}</small><div class="document-ai-source ${document.ai_provider === 'cloud' ? 'cloud' : ''}">${document.short_summary ? `${document.ai_provider === 'cloud' ? 'Bulut AI' : document.ai_provider === 'local' ? 'Yerel AI' : 'AI'} · ${escapeHtml(document.ai_model || 'özet')}` : 'PDF kaydedildi · özet bekliyor'}</div></div></div>
    <div class="document-actions"><button class="action-primary" type="button" data-open-document="${document.id}">PDF’yi oku</button><button class="action-soft" type="button" data-speak-short="${document.id}" ${document.short_summary ? '' : 'disabled'}>Kısa özeti dinle</button><button class="action-soft" type="button" data-speak-long="${document.id}" ${document.long_summary ? '' : 'disabled'}>Uzun özeti dinle</button><button class="small-button" type="button" data-resummarize="${document.id}">${document.short_summary ? 'Seçili AI ile yeniden özetle' : 'Özeti oluştur'}</button><button class="small-button" type="button" data-save-summary="${document.id}" ${document.short_summary ? '' : 'disabled'}>Özeti notlarıma kaydet</button><button class="action-delete" type="button" data-delete-document="${document.id}">Sil</button></div>
    <span class="summary-label">${document.short_summary ? 'KISA ÖZET' : 'ÖZET DURUMU'}</span><p class="document-summary">${escapeHtml(document.short_summary || document.summary_error || 'PDF kaydedildi. Özeti oluşturmak için AI ayarlarını kontrol edip yeniden dene.')}</p>
    ${document.long_summary ? `<details class="document-long-summary"><summary>Uzun özeti gör</summary><p class="document-summary">${escapeHtml(document.long_summary)}</p></details>` : ''}
  </article>`).join('') : '<div class="empty"><strong>Henüz PDF eklemedin.</strong><span>e‑Suzem’den indirdiğin PDF’yi ekle. PDF hemen kütüphanene kaydolur; açabilir veya AI özetini ayrı başlatabilirsin.</span></div>';
  $('documentList').querySelectorAll('[data-open-document]').forEach(button => button.onclick = () => openDocumentPdf(Number(button.dataset.openDocument)));
  $('documentList').querySelectorAll('[data-speak-short]').forEach(button => button.onclick = () => speakDocument(Number(button.dataset.speakShort), false));
  $('documentList').querySelectorAll('[data-speak-long]').forEach(button => button.onclick = () => speakDocument(Number(button.dataset.speakLong), true));
  $('documentList').querySelectorAll('[data-resummarize]').forEach(button => button.onclick = async () => {
    button.disabled = true;
    button.textContent = 'AI özetliyor…';
    try {
      const updated = await api(`/api/study/documents/${button.dataset.resummarize}/summarize`, { method: 'POST' });
      const index = studyDocuments.findIndex(item => item.id === Number(button.dataset.resummarize));
      if (index >= 0) studyDocuments[index] = { ...studyDocuments[index], ...updated };
      renderDocuments();
    } catch (error) { alert(error.message); button.disabled = false; button.textContent = 'Seçili AI ile yeniden özetle'; }
  });
  $('documentList').querySelectorAll('[data-save-summary]').forEach(button => button.onclick = async () => {
    const doc = studyDocuments.find(item => item.id === Number(button.dataset.saveSummary));
    if (!doc) return;
    try {
      await api('/api/study/notes', { method: 'POST', body: JSON.stringify({ title: `${doc.title} · kısa özet`, body: doc.short_summary, source_document_id: doc.id }) });
      button.textContent = '✓ Notlara kaydedildi';
      await loadNotes();
    } catch (error) { alert(error.message); }
  });
  $('documentList').querySelectorAll('[data-delete-document]').forEach(button => button.onclick = async () => {
    if (!confirm('Bu PDF’yi ve özetlerini silmek istiyor musun? Kaydedilmiş notlar kalır.')) return;
    try { await api(`/api/study/documents/${button.dataset.deleteDocument}`, { method: 'DELETE' }); await loadDocuments(); }
    catch (error) { alert(error.message); }
  });
}

function speakDocument(documentId, longVersion) {
  const item = studyDocuments.find(document => document.id === documentId);
  if (!item) return;
  if (!('speechSynthesis' in window)) {
    $('documentStatus').textContent = 'Bu tarayıcıda sesli okuma desteklenmiyor.';
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(`${item.title}. ${longVersion ? item.long_summary : item.short_summary}`);
  utterance.lang = 'tr-TR';
  utterance.rate = 0.96;
  window.speechSynthesis.speak(utterance);
  $('documentStatus').textContent = `${longVersion ? 'Uzun' : 'Kısa'} özet sesli okunuyor. Durdurmak için tarayıcı sesini kapatabilirsin.`;
}

async function loadNotes() {
  try { studyNotes = await api('/api/study/notes'); notesLoaded = true; renderNotes(); await saveOfflineSnapshot({ notes: [...studyNotes] }); }
  catch (error) { $('notesList').innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`; }
}

function renderNotes() {
  $('notesList').innerHTML = studyNotes.length ? studyNotes.map(note => `<article class="note-card">
    <div class="note-card-head"><div><h3>${escapeHtml(note.title)}</h3><time>${formatCreatedAt(note.created_at)}</time>${note.source_title ? `<div class="note-source">Kaynak: ${escapeHtml(note.source_title)}</div>` : ''}</div><button class="note-delete" type="button" data-delete-note="${note.id}">Sil</button></div>
    <p class="note-card-body">${escapeHtml(note.body)}</p>
  </article>`).join('') : '<div class="empty"><strong>Henüz kayıtlı notun yok.</strong><span>Asistanı açıp önemli bir noktayı yazabilir veya PDF özetini bu sayfaya kaydedebilirsin.</span></div>';
  $('notesList').querySelectorAll('[data-delete-note]').forEach(button => button.onclick = async () => {
    if (!confirm('Bu notu silmek istiyor musun?')) return;
    try { await api(`/api/study/notes/${button.dataset.deleteNote}`, { method: 'DELETE' }); await loadNotes(); }
    catch (error) { alert(error.message); }
  });
}

async function downloadProtectedFile(path, filename) {
  try {
    const response = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.detail || 'Dosya indirilemedi.');
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename || decodeURIComponent(response.headers.get('content-disposition')?.split("filename*=UTF-8''")[1] || 'ders-notu.pdf');
    anchor.target = '_blank';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) { alert(error.message); }
}

async function openDocumentPdf(documentId, requestedPage = 1) {
  let item = studyDocuments.find(document => document.id === documentId);
  if (!item) {
    try {
      studyDocuments = await api('/api/study/documents');
      item = studyDocuments.find(document => document.id === documentId);
    } catch (error) {
      alert(error.message);
      return;
    }
  }
  if (!item) return;
  const dialog = $('pdfReaderDialog');
  const status = $('pdfReaderStatus');
  $('pdfReaderTitle').textContent = item.title;
  $('pdfReaderToolbar').hidden = true;
  $('pdfReaderStage').hidden = true;
  status.hidden = false;
  status.textContent = 'PDF sayfaları hazırlanıyor…';
  releasePdfReaderPages();
  pdfReaderDocumentId = documentId;
  pdfReaderPageCount = 0;
  const openRequest = ++pdfReaderRequest;
  if (!dialog.open) dialog.showModal();
  try {
    const pageInfo = await api(`/api/study/documents/${documentId}/pages`);
    if (pdfReaderDocumentId !== documentId || openRequest !== pdfReaderRequest) return;
    pdfReaderPageCount = pageInfo.page_count;
    if (!pdfReaderPageCount) throw new Error('Bu PDF’de okunabilir sayfa bulunamadı.');
    $('pdfPageNumber').max = String(pdfReaderPageCount);
    $('pdfPageCount').textContent = String(pdfReaderPageCount);
    $('pdfReaderToolbar').hidden = false;
    $('pdfReaderStage').hidden = false;
    status.hidden = true;
    buildPdfReaderPages();
    pdfReaderObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) ensurePdfReaderPage(Number(entry.target.dataset.pdfPage));
      }
    }, { root: $('pdfReaderStage'), rootMargin: '1200px 0px' });
    $('pdfPageList').querySelectorAll('[data-pdf-page]').forEach(page => pdfReaderObserver.observe(page));
    $('pdfReaderStage').scrollTop = 0;
    pdfReaderCurrentPage = 1;
    updatePdfReaderControls();
    goToPdfReaderPage(requestedPage);
  } catch (error) {
    status.textContent = error.message;
  }
}

function buildPdfReaderPages() {
  const list = $('pdfPageList');
  list.replaceChildren();
  const fragment = document.createDocumentFragment();
  for (let pageNumber = 1; pageNumber <= pdfReaderPageCount; pageNumber += 1) {
    const section = document.createElement('section');
    section.className = 'pdf-page';
    section.dataset.pdfPage = String(pageNumber);
    const label = document.createElement('span');
    label.className = 'pdf-page-label';
    label.textContent = `Sayfa ${pageNumber}`;
    const placeholder = document.createElement('div');
    placeholder.className = 'pdf-page-placeholder';
    placeholder.textContent = 'Sayfa kaydırırken yüklenecek…';
    section.append(label, placeholder);
    fragment.append(section);
  }
  list.append(fragment);
}

async function ensurePdfReaderPage(pageNumber) {
  if (!pdfReaderDocumentId || !pdfReaderPageCount || pageNumber < 1 || pageNumber > pdfReaderPageCount) return;
  const section = $('pdfPageList').querySelector(`[data-pdf-page="${pageNumber}"]`);
  if (!section || section.dataset.loading === 'true' || section.dataset.loaded === 'true') return;
  const documentId = pdfReaderDocumentId;
  const requestId = pdfReaderRequest;
  section.dataset.loading = 'true';
  const placeholder = section.querySelector('.pdf-page-placeholder');
  if (placeholder) placeholder.textContent = 'Sayfa yükleniyor…';
  try {
    const response = await fetch(`/api/study/documents/${documentId}/pages/${pageNumber}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.detail || 'PDF sayfası açılamadı.');
    }
    const blob = await response.blob();
    const imageUrl = URL.createObjectURL(blob);
    if (requestId !== pdfReaderRequest || documentId !== pdfReaderDocumentId) {
      URL.revokeObjectURL(imageUrl);
      return;
    }
    const image = document.createElement('img');
    image.alt = `PDF sayfa ${pageNumber}`;
    image.decoding = 'async';
    image.onload = () => {
      if (requestId !== pdfReaderRequest || documentId !== pdfReaderDocumentId) {
        URL.revokeObjectURL(imageUrl);
        return;
      }
      section.dataset.loading = 'false';
      section.dataset.loaded = 'true';
      section.querySelector('.pdf-page-placeholder')?.remove();
      section.append(image);
      pdfReaderObjectUrls.set(pageNumber, imageUrl);
      evictDistantPdfReaderPages(pdfReaderCurrentPage);
    };
    image.onerror = () => {
      URL.revokeObjectURL(imageUrl);
      section.dataset.loading = 'false';
      if (requestId === pdfReaderRequest) {
        const message = section.querySelector('.pdf-page-placeholder');
        if (message) message.textContent = 'Bu sayfa görüntülenemedi. Sayfa numarasını yeniden seçip tekrar dene.';
      }
    };
    image.src = imageUrl;
  } catch (error) {
    section.dataset.loading = 'false';
    if (requestId === pdfReaderRequest) {
      const message = section.querySelector('.pdf-page-placeholder');
      if (message) message.textContent = error.message;
    }
  }
}

function updatePdfReaderControls() {
  $('pdfPageNumber').value = String(pdfReaderCurrentPage);
  $('pdfPreviousPage').disabled = pdfReaderCurrentPage <= 1;
  $('pdfNextPage').disabled = pdfReaderCurrentPage >= pdfReaderPageCount;
}

function goToPdfReaderPage(pageNumber) {
  if (!pdfReaderDocumentId || !pdfReaderPageCount) return;
  const page = Math.max(1, Math.min(pdfReaderPageCount, Number(pageNumber) || 1));
  const previousPage = pdfReaderCurrentPage;
  pdfReaderCurrentPage = page;
  updatePdfReaderControls();
  const section = $('pdfPageList').querySelector(`[data-pdf-page="${page}"]`);
  section?.scrollIntoView({ behavior: Math.abs(page - previousPage) > 2 ? 'instant' : 'smooth', block: 'start' });
  ensurePdfReaderPage(page);
  evictDistantPdfReaderPages(page);
}

function evictDistantPdfReaderPages(currentPage) {
  for (const [pageNumber, imageUrl] of pdfReaderObjectUrls) {
    if (Math.abs(pageNumber - currentPage) <= 5) continue;
    URL.revokeObjectURL(imageUrl);
    pdfReaderObjectUrls.delete(pageNumber);
    const section = $('pdfPageList').querySelector(`[data-pdf-page="${pageNumber}"]`);
    if (!section) continue;
    section.querySelector('img')?.remove();
    section.dataset.loaded = 'false';
    if (!section.querySelector('.pdf-page-placeholder')) {
      const placeholder = document.createElement('div');
      placeholder.className = 'pdf-page-placeholder';
      placeholder.textContent = 'Sayfa kaydırırken yüklenecek…';
      section.append(placeholder);
    }
  }
}

function releasePdfReaderPages() {
  pdfReaderObserver?.disconnect();
  pdfReaderObserver = null;
  for (const imageUrl of pdfReaderObjectUrls.values()) URL.revokeObjectURL(imageUrl);
  pdfReaderObjectUrls.clear();
  $('pdfPageList').replaceChildren();
}

function closePdfReader() {
  pdfReaderRequest += 1;
  pdfReaderDocumentId = null;
  pdfReaderPageCount = 0;
  releasePdfReaderPages();
}

function renderAssistantSources(sources, privacyNote, usedMaterials) {
  const container = $('assistantSources');
  container.replaceChildren();
  if (!sources?.length) {
    const status = document.createElement('p');
    status.className = 'assistant-source-status';
    status.textContent = privacyNote || (usedMaterials
      ? 'Notların yanıtı destekledi; PDF’lerinde eşleşen bir bölüm bulamadım.'
      : 'PDF’lerinde eşleşen bir bölüm bulamadım. Yanıt genel bilgiyle hazırlandı.');
    container.append(status);
    return;
  }
  const heading = document.createElement('strong');
  heading.textContent = 'Bulunan PDF bölümleri';
  container.append(heading);
  for (const source of sources) {
    const card = document.createElement('article');
    card.className = 'assistant-source';
    const text = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = `${source.title} · ${source.page_number ? `Sayfa ${source.page_number}` : 'PDF'}`;
    const excerpt = document.createElement('p');
    excerpt.textContent = source.excerpt;
    text.append(title, excerpt);
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'small-button';
    open.textContent = 'Aç';
    open.onclick = () => openDocumentPdf(Number(source.document_id), Number(source.page_number) || 1);
    card.append(text, open);
    container.append(card);
  }
}

async function loadContacts() {
  try {
    const contacts = await api('/api/messages/contacts');
    let hasIncomingMessage = false;
    for (const contact of contacts) {
      const contactKey = contact.email.trim().toLowerCase();
      const previousUnread = contactUnreadCounts.get(contactKey);
      const unreadCount = Number(contact.unread_count || 0);
      const rawMessageTime = String(contact.created_at || '');
      const messageTime = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(rawMessageTime) ? rawMessageTime : `${rawMessageTime}Z`);
      if ((previousUnread !== undefined && unreadCount > previousUnread)
        || (previousUnread === undefined && messageTime > messageSoundSessionStartedAt)) {
        hasIncomingMessage = true;
      }
      contactUnreadCounts.set(contactKey, unreadCount);
    }
    if (hasIncomingMessage) playMessageNotification('received');
    $('contactList').innerHTML = contacts.length ? contacts.map(contact => `<button type="button" class="contact-item ${activeConversationEmail === contact.email ? 'selected' : ''}" data-contact-email="${escapeHtml(contact.email)}"><strong>${escapeHtml(contact.full_name)}${contact.unread_count ? `<span class="message-unread">${contact.unread_count}</span>` : ''}</strong><small>${escapeHtml(contact.email)}</small></button>`).join('') : '<div class="empty"><strong>Sohbet yok.</strong><span>Bir arkadaşının e-posta adresini girerek başlayabilirsin.</span></div>';
    $('contactList').querySelectorAll('[data-contact-email]').forEach(button => button.onclick = () => openConversation(button.dataset.contactEmail));
  } catch (error) { $('contactList').innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`; }
}

async function refreshConversation(email, initial = false) {
  const wasNearBottom = $('conversationMessages').scrollHeight - $('conversationMessages').scrollTop - $('conversationMessages').clientHeight < 60;
    if (initial) {
      $('conversationMessages').replaceChildren();
      $('messageForm').hidden = true;
      $('conversationHint').textContent = 'Sohbet yükleniyor…';
  }
  try {
    const messages = await api(`/api/messages/conversation?email=${encodeURIComponent(email)}`);
    if (activeConversationEmail !== email) return;
    $('conversationHint').textContent = messages.length ? `${email} ile sohbet · Yeni mesajlar otomatik güncellenir` : `${email} ile sohbet başladı. İlk mesajını yazabilirsin.`;
    $('messageForm').hidden = false;
    const previousMessageIds = new Set(conversationSignature.split('|').filter(Boolean).map(item => Number(item.split(':', 1)[0])));
    if (!initial && messages.some(message => message.sender_id !== currentUserId && !previousMessageIds.has(message.id))) {
      playMessageNotification('received');
    }
    const signature = messages.map(message => `${message.id}:${message.read_at || ''}`).join('|');
    if (signature !== conversationSignature) {
      conversationSignature = signature;
      $('conversationMessages').innerHTML = messages.length ? messages.map(message => `<article class="message-bubble ${message.sender_id === currentUserId ? 'mine' : ''}">
      <div class="message-author">${message.sender_id === currentUserId ? 'Sen' : escapeHtml(message.sender_name)}</div>
      ${message.body ? `<p class="message-body">${escapeHtml(message.body)}</p>` : ''}
      ${message.attachment_name ? (isAudioAttachment(message.attachment_name) ? `<button type="button" class="message-attachment audio-message-button" data-audio-message="${message.id}" data-file-name="${escapeHtml(message.attachment_name)}">▶ Sesli mesajı yükle · ${escapeHtml(message.attachment_name)}</button>` : `<button type="button" class="message-attachment" data-message-file="${message.id}" data-file-name="${escapeHtml(message.attachment_name)}">📎 ${escapeHtml(message.attachment_name)}</button>`) : ''}
      <div class="message-time">${formatCreatedAt(message.created_at)}${message.sender_id === currentUserId ? ` · ${message.read_at ? 'Okundu' : 'Gönderildi'}` : ''}</div>
    </article>`).join('') : '<div class="conversation-hint">Bu sohbette henüz mesaj yok.</div>';
      revokeAudioMessageUrls();
      $('conversationMessages').querySelectorAll('[data-message-file]').forEach(button => button.onclick = () => downloadProtectedFile(`/api/messages/${button.dataset.messageFile}/attachment`, button.dataset.fileName));
      $('conversationMessages').querySelectorAll('[data-audio-message]').forEach(button => button.onclick = () => loadProtectedAudio(button));
      if (initial || wasNearBottom) $('conversationMessages').scrollTop = $('conversationMessages').scrollHeight;
    }
    await loadContacts();
  } catch (error) {
    if (initial) $('conversationHint').textContent = error.message;
  }
}

async function openConversation(email) {
  activeConversationEmail = email.trim().toLowerCase();
  activeConversationUserId = null;
  conversationSignature = '';
  $('recipientEmail').value = activeConversationEmail;
  $('conversationActions').hidden = true;
  $('messageForm').hidden = true;
  try {
    const partner = await api(`/api/messages/lookup?email=${encodeURIComponent(activeConversationEmail)}`);
    if (activeConversationEmail !== partner.email.toLowerCase()) return;
    activeConversationUserId = partner.user_id;
    $('conversationActions').hidden = false;
    await refreshConversation(activeConversationEmail, true);
  } catch (error) {
    $('conversationHint').textContent = error.message;
  }
}

setInterval(() => {
  if (!token || document.hidden) return;
  if (!$('messagesPage').hidden && activeConversationEmail) refreshConversation(activeConversationEmail);
  else loadContacts();
}, 5000);

function toggleAssistant(open) {
  $('assistantPanel').hidden = !open;
  if (open) $('assistantQuestion').focus();
}

let currentAISettings = null;

function setAIProviderVisibility() {
  const local = $('aiProvider').value === 'local';
  $('localAIConfig').hidden = !local;
  $('cloudAIConfig').hidden = local;
}

function showAIStatus(result) {
  const area = $('aiSettingsStatus');
  const ready = Boolean(result.available && result.model_ready);
  area.className = `ai-status ${ready ? 'good' : 'bad'}`;
  const message = escapeHtml(result.message || 'AI durumu kontrol edilemedi.');
  const link = result.install_url ? ` <a href="${escapeHtml(result.install_url)}" target="_blank" rel="noopener noreferrer">Ollama’yı indir ↗</a>` : '';
  area.innerHTML = `${ready ? '● ' : '○ '}${message}${link}`;
  $('assistantModeFooter').textContent = `Seçili mod: ${result.provider === 'cloud' ? 'Bulut AI' : 'Yerel AI'} · ${result.model}${ready ? ' · hazır' : ' · bağlantı bekleniyor'}`;
}

async function loadAIStatus() {
  try {
    const result = await api('/api/ai/status');
    showAIStatus(result);
    return result;
  } catch (error) {
    $('aiSettingsStatus').className = 'ai-status bad';
    $('aiSettingsStatus').textContent = error.message;
    return null;
  }
}

async function loadAIUsage() {
  try {
    const usage = await api('/api/ai/usage');
    $('aiUsageSummary').innerHTML = ['local', 'cloud'].map(provider => {
      const entry = usage.providers[provider];
      const label = provider === 'local' ? 'Yerel AI' : 'Bulut AI';
      return `<div class="usage-chip"><strong>${entry.requests} istek</strong><small>${label} · ${Number(entry.input_characters).toLocaleString('tr-TR')} girdi karakteri</small></div>`;
    }).join('');
  } catch { $('aiUsageSummary').textContent = 'Kullanım bilgisi yüklenemedi.'; }
}

async function loadAISettings() {
  try {
    const settings = await api('/api/ai/settings');
    currentAISettings = settings;
    $('aiProvider').value = settings.provider;
    $('localAIModel').value = settings.local_model;
    $('cloudAIModel').value = settings.cloud_model;
    $('cloudAPIKey').value = '';
    $('cloudKeyStatus').textContent = settings.cloud_api_key_set ? `Şifreli kayıtlı anahtar var (${settings.cloud_api_key_hint}). Yeni anahtar yazmazsan korunur.` : 'Henüz kayıtlı anahtar yok. Bulut modunu kullanmak için API anahtarı ekle.';
    $('clearCloudAPIKey').checked = false;
    $('shareMaterialsCloud').checked = settings.share_materials_cloud;
    $('aiResponseLength').value = settings.response_length;
    $('aiTemperature').value = String(settings.temperature);
    $('includeAISources').checked = settings.include_sources;
    setAIProviderVisibility();
    await Promise.all([loadAIStatus(), loadAIUsage()]);
  } catch (error) {
    $('aiSettingsStatus').className = 'ai-status bad';
    $('aiSettingsStatus').textContent = error.message;
  }
}

async function saveAISettings(quiet = false) {
  const payload = {
    provider: $('aiProvider').value,
    local_model: $('localAIModel').value.trim(),
    cloud_model: $('cloudAIModel').value.trim(),
    cloud_api_key: $('cloudAPIKey').value || null,
    clear_cloud_api_key: $('clearCloudAPIKey').checked,
    response_length: $('aiResponseLength').value,
    temperature: Number($('aiTemperature').value),
    share_materials_cloud: $('shareMaterialsCloud').checked,
    include_sources: $('includeAISources').checked,
  };
  const button = $('aiSettingsForm').querySelector('[type="submit"]');
  button.disabled = true;
  if (!quiet) button.textContent = 'Kaydediliyor…';
  try {
    const updated = await api('/api/ai/settings', { method: 'PUT', body: JSON.stringify(payload) });
    currentAISettings = updated;
    $('cloudAPIKey').value = '';
    $('clearCloudAPIKey').checked = false;
    $('cloudKeyStatus').textContent = updated.cloud_api_key_set ? `Şifreli kayıtlı anahtar var (${updated.cloud_api_key_hint}). Yeni anahtar yazmazsan korunur.` : 'Henüz kayıtlı anahtar yok. Bulut modunu kullanmak için API anahtarı ekle.';
    if (!quiet) {
      $('aiSettingsStatus').className = 'ai-status good';
      $('aiSettingsStatus').textContent = '✓ AI ve gizlilik ayarların kaydedildi.';
    }
    await loadAIStatus();
    return true;
  } catch (error) {
    $('aiSettingsStatus').className = 'ai-status bad';
    $('aiSettingsStatus').textContent = error.message;
    return false;
  } finally {
    button.disabled = false;
    if (!quiet) button.textContent = 'Ayarları kaydet';
  }
}

async function refreshLocalModels() {
  const button = $('refreshLocalModels');
  button.disabled = true;
  try {
    const result = await api('/api/ai/local/models');
    $('localModelList').innerHTML = result.models.map(model => `<option value="${escapeHtml(model)}"></option>`).join('');
    $('aiSettingsStatus').className = 'ai-status good';
    $('aiSettingsStatus').textContent = result.models.length ? `Ollama hazır. ${result.models.length} yerel model bulundu.` : 'Ollama çalışıyor ancak indirilmiş model yok. Komutu çalıştırıp modeli indir.';
    await loadAIStatus();
  } catch (error) {
    $('aiSettingsStatus').className = 'ai-status bad';
    $('aiSettingsStatus').innerHTML = `${escapeHtml(error.message)} <a href="https://ollama.com/download/windows" target="_blank" rel="noopener noreferrer">Ollama’yı indir ↗</a>`;
  } finally { button.disabled = false; }
}

async function runAITest() {
  if (!await saveAISettings(true)) return;
  const button = $('testAI');
  button.disabled = true;
  button.textContent = 'Model yanıtlıyor…';
  try {
    const result = await api('/api/ai/test', { method: 'POST' });
    const mode = result.provider === 'cloud' ? 'Bulut AI' : 'Yerel AI';
    $('aiSettingsStatus').className = 'ai-status good';
    $('aiSettingsStatus').textContent = `✓ ${mode} · ${result.model} yanıt verdi: ${result.answer}`;
    $('assistantModeFooter').textContent = `Son yanıt: ${mode} · ${result.model}`;
    await loadAIUsage();
  } catch (error) {
    $('aiSettingsStatus').className = 'ai-status bad';
    $('aiSettingsStatus').textContent = error.message;
  } finally { button.disabled = false; button.textContent = 'Küçük bir yanıt dene'; }
}

async function exportAccountData() {
  const button = $('exportAccountData');
  button.disabled = true;
  $('exportStatus').textContent = 'Verilerin hazırlanıyor…';
  try {
    const response = await fetch('/api/account/export', { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.detail || 'Dışa aktarma başarısız.');
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `campusflow-verilerim-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    $('exportStatus').textContent = '✓ JSON dosyası indirildi. Parola ve API anahtarı dışa aktarılmaz.';
  } catch (error) { $('exportStatus').textContent = error.message; }
  finally { button.disabled = false; }
}

function sortedByUrgency(items) {
  return [...items].sort((a, b) => {
    const urgencyBucket = task => {
      if (!task.due_at) return 4;
      const hoursUntilDue = (new Date(task.due_at).getTime() - Date.now()) / 3_600_000;
      if (hoursUntilDue <= 0) return 0;
      if (hoursUntilDue <= 24) return 1;
      if (hoursUntilDue <= 72) return 2;
      if (hoursUntilDue <= 168) return 3;
      return 4;
    };
    const aBucket = urgencyBucket(a);
    const bBucket = urgencyBucket(b);
    if (aBucket !== bBucket) return aBucket - bBucket;
    const aDue = a.due_at ? new Date(a.due_at).getTime() : Infinity;
    const bDue = b.due_at ? new Date(b.due_at).getTime() : Infinity;
    if (aBucket < 4 && aDue !== bDue) return aDue - bDue;
    if (b.priority !== a.priority) return b.priority - a.priority;
    if ((a.status === 'in_progress') !== (b.status === 'in_progress')) return a.status === 'in_progress' ? -1 : 1;
    if (aDue !== bDue) return aDue - bDue;
    return a.id - b.id;
  });
}

function taskPlanReason(task) {
  const priority = `${priorityNames[task.priority]} öncelik`;
  if (isOverdue(task)) return `Teslim tarihi geçti · ${formatDueDate(task.due_at)}`;
  if (task.due_at) {
    const hoursUntilDue = (new Date(task.due_at).getTime() - Date.now()) / 3_600_000;
    const deadline = hoursUntilDue < 24 ? 'Bugün teslim' : hoursUntilDue < 48 ? 'Yarın teslim' : hoursUntilDue < 168 ? 'Bu hafta teslim' : formatDueDate(task.due_at);
    return `${deadline} · ${priority}`;
  }
  if (task.status === 'in_progress') return `Devam ediyor · ${priority}`;
  return `Son tarih eklenmemiş · ${priority}`;
}

function renderFocus() {
  const nextTask = sortedByUrgency(tasks.filter(task => task.status !== 'done'))[0];
  if (!nextTask) {
    $('focusTitle').textContent = tasks.length ? 'Harika, açık görevin kalmadı!' : 'Bugün için bir görev ekle';
    $('focusMeta').textContent = tasks.length ? 'İstersen yeni hedefini planına ekleyebilirsin.' : 'Planını küçük adımlarla oluşturmaya başla.';
    $('focusAction').textContent = 'Görev oluştur';
    $('focusAction').onclick = () => openTaskDialog();
    return;
  }
  const courseName = courses.find(course => course.id === nextTask.course_id)?.code;
  $('focusTitle').textContent = nextTask.title;
  $('focusMeta').textContent = `${isOverdue(nextTask) ? 'Gecikti' : nextTask.due_at ? `Son tarih ${formatDueDate(nextTask.due_at)}` : 'Son tarih belirlenmemiş'} · ${priorityNames[nextTask.priority]} öncelik${courseName ? ` · ${courseName}` : ''}`;
  $('focusAction').textContent = 'Görevlerime git';
  $('focusAction').onclick = () => $('taskList').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderNextTasks() {
  const openTasks = sortedByUrgency(tasks.filter(task => task.status !== 'done'));
  const nextTasks = openTasks.slice(1, 3);
  $('nextTasksCount').textContent = openTasks.length > 1 ? `${nextTasks.length} görev` : '';
  $('nextTaskList').innerHTML = nextTasks.length ? nextTasks.map((task, index) => {
    const courseCode = courses.find(course => course.id === task.course_id)?.code;
    const nextStatus = task.status === 'in_progress' ? 'done' : 'in_progress';
    const action = task.status === 'in_progress' ? 'Tamamla' : 'Başlat';
    return `<article class="next-task-item">
      <span class="next-task-rank">0${index + 2}</span>
      <div class="next-task-copy"><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(taskPlanReason(task))}${courseCode ? ` · ${escapeHtml(courseCode)}` : ''}</small></div>
      <button type="button" class="next-task-action" data-plan-task="${task.id}" data-plan-status="${nextStatus}">${action}</button>
    </article>`;
  }).join('') : `<p class="next-task-empty">${openTasks.length ? 'Şimdilik bir sonraki işin bu; kalan görevlerini aşağıda görebilirsin.' : 'Ek görev yok. Yeni bir teslim eklediğinde öncelik sıran burada oluşur.'}</p>`;
  $('nextTaskList').querySelectorAll('[data-plan-task]').forEach(button => {
    button.onclick = async () => {
      button.disabled = true;
      try {
        await api(`/api/tasks/${button.dataset.planTask}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: button.dataset.planStatus }),
        });
        await loadDashboard();
      } catch (error) {
        alert(error.message);
        button.disabled = false;
      }
    };
  });
}

function gradeTargetGuidance(course) {
  if (!course.grades.length) return 'Not ekledikçe hedef nota kalan ihtiyacın burada hesaplanır.';
  const totalWeight = course.grades.reduce((sum, grade) => sum + grade.weight, 0);
  if (totalWeight > 100.000001) {
    return `Değerlendirme ağırlıkları toplamı %${totalWeight.toLocaleString('tr-TR', { maximumFractionDigits: 2 })}; hedef hesabı için %100 veya altına indir.`;
  }

  const weightedPoints = course.grades.reduce((sum, grade) => sum + grade.score * grade.weight, 0);
  const remainingWeight = Math.max(0, 100 - totalWeight);
  const targetText = Number(course.target_grade).toLocaleString('tr-TR', { maximumFractionDigits: 2 });
  if (remainingWeight < 0.000001) {
    const finalGrade = weightedPoints / totalWeight;
    return finalGrade >= course.target_grade
      ? `Dönem notun ${finalGrade.toLocaleString('tr-TR', { maximumFractionDigits: 2 })}; ${targetText} hedefini karşıladın.`
      : `Dönem notun ${finalGrade.toLocaleString('tr-TR', { maximumFractionDigits: 2 })}; tüm ağırlık girildiği için hedef not güncellenmeli.`;
  }

  const required = (course.target_grade * 100 - weightedPoints) / remainingWeight;
  const remainingText = remainingWeight.toLocaleString('tr-TR', { maximumFractionDigits: 2 });
  if (required <= 0) return `Kalan %${remainingText} değerlendirmede 0 alsan bile ${targetText} hedefini koruyorsun.`;
  if (required > 100) return `Kalan %${remainingText} değerlendirmelerde 100 alsan bile ${targetText} hedefi mevcut notlarla yakalanamıyor.`;
  const minimum = Math.ceil((required - 1e-9) * 100) / 100;
  const minimumText = minimum.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${targetText} hedefi için kalan %${remainingText} değerlendirmelerde ortalama en az %${minimumText} gerekiyor.`;
}

function renderSchedule() {
  const dayNames = ['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar'];
  if (!scheduleEntries.length) {
    $('weeklySchedule').innerHTML = '<div class="schedule-empty"><strong>Haftalık programın henüz eklenmedi.</strong>Üniversitenin PDF’ini veya program fotoğrafını yükle; dersler, günler ve saatler taslağa aktarılsın.</div>';
    return;
  }
  $('weeklySchedule').innerHTML = dayNames.map((day, weekday) => {
    const dayEntries = scheduleEntries.filter(entry => entry.weekday === weekday).sort((a, b) => a.start_time.localeCompare(b.start_time));
    return `<section class="weekday-column"><div class="weekday-heading">${day}<span>${dayEntries.length || '—'}</span></div>${dayEntries.length ? dayEntries.map(entry => `
      <article class="meeting-card"><div class="meeting-time">${escapeHtml(entry.start_time)}–${escapeHtml(entry.end_time)}</div><div class="meeting-name">${escapeHtml(entry.name)}</div><div class="meeting-course">${escapeHtml(entry.code)}</div>${entry.room ? `<div class="meeting-room">⌖ Derslik · ${escapeHtml(entry.room)}</div>` : ''}${entry.instructor ? `<div class="meeting-info">${escapeHtml(entry.instructor)}</div>` : ''}${entry.course_note ? `<div class="meeting-note" title="${escapeHtml(entry.course_note)}"><span>Not</span> ${escapeHtml(entry.course_note)}</div>` : ''}</article>`).join('') : '<div class="meeting-info">Ders yok</div>'}</section>`;
  }).join('');
}

function renderCourses() {
  $('courseList').innerHTML = courses.length ? courses.map(course => {
    const average = course.analytics.weighted_average;
    const progress = course.analytics.progress_percent;
    const gradeRows = course.grades.length ? course.grades.map(grade => `
      <div class="grade-row"><span class="grade-entry-name">${escapeHtml(grade.name)} <small>%${grade.weight}</small></span><strong>${grade.score}</strong><div class="grade-entry-actions"><button type="button" class="grade-entry-action" data-edit-grade="${grade.id}" data-course="${course.id}">Düzenle</button><button type="button" class="grade-entry-action delete" data-delete-grade="${grade.id}" data-course="${course.id}">Sil</button></div></div>`).join('') : '<p class="grade-empty">Not eklenmedi. İlk sınav veya değerlendirme notunu ekle.</p>';
    return `<article class="course-card">
      <div class="course-heading"><div><span class="course-code">${escapeHtml(course.code)}</span><h3>${escapeHtml(course.name)}</h3></div><button class="small-button" data-grade="${course.id}">+ Not ekle</button></div>
      <div class="course-meta">${course.credits} kredi <span>·</span> Hedef ${course.target_grade}</div>
      <div class="grade-progress"><div class="progress-label"><span>${average === null ? 'Henüz ortalama yok' : `Dönem ortalaması ${average}`}</span><span>${average === null ? 'Not bekleniyor' : `Hedefin %${progress}`}</span></div><div class="progress-track"><span style="width:${average === null ? 0 : progress}%"></span></div></div>
      <p class="grade-target-guidance">${escapeHtml(gradeTargetGuidance(course))}</p>
      <details class="grade-details"><summary>Not dökümü <span>${course.grades.length}</span></summary><div class="grade-list">${gradeRows}</div></details>
      <details class="course-note-editor"><summary>📝 Ders hakkında not <span>${course.course_note ? 'Not var' : 'Not ekle'}</span></summary><form class="course-note-form" data-course-note="${course.id}"><label class="sr-only" for="courseNote${course.id}">Ders hakkında not</label><textarea id="courseNote${course.id}" maxlength="1200" rows="3" placeholder="Bu dersle ilgili hatırlamak istediğin kısa bir not…">${escapeHtml(course.course_note || '')}</textarea><div class="course-note-actions"><small aria-live="polite"></small><button type="submit" class="secondary small-button">Notu kaydet</button></div></form></details>
    </article>`;
  }).join('') : '<div class="empty"><strong>Henüz ders eklemedin.</strong><span>Derslerini ekle; hedef notunu ve dönem ortalamanı burada takip et.</span></div>';
  $('courseList').querySelectorAll('[data-grade]').forEach(button => button.onclick = () => openGradeDialog(Number(button.dataset.grade)));
  $('courseList').querySelectorAll('[data-edit-grade]').forEach(button => {
    button.onclick = () => {
      const course = courses.find(item => item.id === Number(button.dataset.course));
      const grade = course?.grades.find(item => item.id === Number(button.dataset.editGrade));
      if (course && grade) openGradeDialog(course.id, grade);
    };
  });
  $('courseList').querySelectorAll('[data-delete-grade]').forEach(button => {
    button.onclick = async () => {
      const courseId = Number(button.dataset.course);
      const grade = courses.find(item => item.id === courseId)?.grades.find(item => item.id === Number(button.dataset.deleteGrade));
      if (!grade || !confirm(`“${grade.name}” değerlendirmesini silmek istiyor musun?`)) return;
      button.disabled = true;
      try {
        await api(`/api/courses/${courseId}/grades/${grade.id}`, { method: 'DELETE' });
        await loadDashboard();
      } catch (error) {
        alert(error.message);
        button.disabled = false;
      }
    };
  });
  $('courseList').querySelectorAll('[data-course-note]').forEach(form => form.onsubmit = async event => {
    event.preventDefault();
    const courseId = Number(form.dataset.courseNote);
    const course = courses.find(item => item.id === courseId);
    const textarea = form.querySelector('textarea');
    const button = form.querySelector('button[type="submit"]');
    const status = form.querySelector('small');
    button.disabled = true;
    status.textContent = 'Kaydediliyor…';
    try {
      const result = await api(`/api/courses/${courseId}/note`, { method: 'PUT', body: JSON.stringify({ course_note: textarea.value }) });
      course.course_note = result.course_note;
      for (const entry of scheduleEntries) if (entry.course_id === courseId) entry.course_note = result.course_note;
      form.closest('details').querySelector('summary span').textContent = result.course_note ? 'Not var' : 'Not ekle';
      status.textContent = '✓ Ders notun kaydedildi.';
      renderSchedule();
      await saveOfflineSnapshot();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
}

function renderTasks() {
  const filter = $('taskFilter').value;
  const filtered = sortedByUrgency(tasks).filter(task => {
    if (filter === 'open') return task.status !== 'done';
    if (filter === 'overdue') return isOverdue(task);
    if (filter === 'done') return task.status === 'done';
    return true;
  });
  $('visibleTaskCount').textContent = `${filtered.length} görev`;
  $('taskList').innerHTML = filtered.length ? filtered.map(task => {
    const courseCode = courses.find(course => course.id === task.course_id)?.code;
    const dueText = task.due_at ? formatDueDate(task.due_at) : 'Son tarih yok';
    const dueLabel = isOverdue(task) ? `Gecikti · ${dueText}` : dueText;
    return `<article class="task-card ${isOverdue(task) ? 'is-overdue' : ''} ${task.status === 'done' ? 'is-done' : ''}">
      <div class="task-main"><div class="task-title-row"><span class="task-priority priority-${task.priority}"></span><h3>${escapeHtml(task.title)}</h3></div>
        <p class="task-meta"><span>${escapeHtml(statusNames[task.status] || task.status)}</span><span>·</span><span>${escapeHtml(dueLabel)}</span>${courseCode ? `<span>·</span><span>${escapeHtml(courseCode)}</span>` : ''}</p>
        ${task.description ? `<p class="task-description">${escapeHtml(task.description)}</p>` : ''}
      </div>
      <div class="task-actions"><span class="priority-label">${task.priority} · ${priorityNames[task.priority]}</span>
        <select aria-label="${escapeHtml(task.title)} görev durumu" data-status="${task.id}"><option value="todo" ${task.status === 'todo' ? 'selected' : ''}>Yapılacak</option><option value="in_progress" ${task.status === 'in_progress' ? 'selected' : ''}>Devam ediyor</option><option value="done" ${task.status === 'done' ? 'selected' : ''}>Tamamlandı</option></select>
        <button class="text-button" data-edit="${task.id}">Düzenle</button><button class="text-button delete-button" data-delete="${task.id}">Sil</button>
      </div>
    </article>`;
  }).join('') : `<div class="empty"><strong>${filter === 'overdue' ? 'Geciken görev yok.' : filter === 'done' ? 'Henüz tamamlanan görev yok.' : filter === 'open' ? 'Açık görevin yok.' : 'Henüz görev eklemedin.'}</strong><span>${filter === 'all' || filter === 'open' ? 'Bir görev ekleyerek planını oluşturmaya başlayabilirsin.' : 'Durum filtresini değiştirip diğer görevlerine bakabilirsin.'}</span></div>`;
  $('taskList').querySelectorAll('[data-status]').forEach(select => {
    select.onchange = async () => {
      select.disabled = true;
      try { await api(`/api/tasks/${select.dataset.status}`, { method: 'PATCH', body: JSON.stringify({ status: select.value }) }); await loadDashboard(); }
      catch (error) { alert(error.message); select.disabled = false; }
    };
  });
  $('taskList').querySelectorAll('[data-edit]').forEach(button => button.onclick = () => openTaskDialog(tasks.find(task => task.id === Number(button.dataset.edit))));
  $('taskList').querySelectorAll('[data-delete]').forEach(button => {
    button.onclick = async () => {
      if (!confirm('Bu görevi silmek istiyor musun?')) return;
      try { await api(`/api/tasks/${button.dataset.delete}`, { method: 'DELETE' }); await loadDashboard(); }
      catch (error) { alert(error.message); }
    };
  });
}

async function loadDashboard() {
  const [dashboard, courseRows, taskRows, meetingRows] = await Promise.all([api('/api/dashboard'), api('/api/courses'), api('/api/tasks'), api('/api/schedule')]);
  const courseDetails = await Promise.all(courseRows.map(async course => {
    const [analytics, grades] = await Promise.all([api(`/api/courses/${course.id}/analytics`), api(`/api/courses/${course.id}/grades`)]);
    return { ...course, analytics, grades };
  }));
  courses = courseDetails;
  tasks = taskRows;
  scheduleEntries = meetingRows;
  dashboardLoaded = true;
  const openCount = tasks.filter(task => task.status !== 'done').length;
  $('courses').textContent = dashboard.total_courses;
  $('tasks').textContent = openCount;
  $('taskCountHint').textContent = `${dashboard.completed_tasks} tamamlandı · ${tasks.length} toplam`;
  $('completion').textContent = `${dashboard.completion_rate}%`;
  $('average').textContent = dashboard.average_grade ?? '—';
  $('overdue').textContent = dashboard.overdue_tasks;
  renderCourses();
  renderTasks();
  renderSchedule();
  renderFocus();
  renderNextTasks();
  $('taskForm').elements.course_id.innerHTML = '<option value="">Derse bağlama</option>' + courses.map(course => `<option value="${course.id}">${escapeHtml(course.code)} · ${escapeHtml(course.name)}</option>`).join('');
  await saveOfflineSnapshot();
}

function localDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function openTaskDialog(task = null) {
  editingTaskId = task?.id ?? null;
  const form = $('taskForm');
  form.reset();
  form.elements.priority.value = task?.priority ?? '3';
  form.elements.title.value = task?.title ?? '';
  form.elements.description.value = task?.description ?? '';
  form.elements.course_id.value = task?.course_id ?? '';
  form.elements.due_at.value = localDateTime(task?.due_at);
  $('taskDialogTitle').textContent = task ? 'Görevi düzenle' : 'Yeni görev';
  form.querySelector('.formMsg').textContent = '';
  $('taskDialog').showModal();
}

function openGradeDialog(courseId, grade = null) {
  addingGradeTo = courseId;
  editingGradeId = grade?.id ?? null;
  const course = courses.find(item => item.id === courseId);
  const form = $('gradeForm');
  form.reset();
  form.elements.name.value = grade?.name ?? '';
  form.elements.score.value = grade?.score ?? '';
  form.elements.weight.value = grade?.weight ?? '';
  form.querySelector('.formMsg').textContent = '';
  $('gradeDialogTitle').textContent = grade ? 'Değerlendirmeyi düzenle' : 'Değerlendirme ekle';
  $('gradeSaveButton').textContent = grade ? 'Değişiklikleri kaydet' : 'Notu kaydet';
  $('gradeCourseHint').textContent = `${course.code} · ${course.name} için not ve ağırlığı gir. Toplam ağırlık %100’ü geçemez.`;
  $('gradeDialog').showModal();
}

const scheduleDayNames = ['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar'];

function foldSearch(value) {
  return value.toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i');
}

function visibleScheduleDraft() {
  const query = foldSearch($('departmentSearch').value.trim());
  return scheduleDraft.map((course, index) => ({ course, index })).filter(({ course }) => !query || foldSearch(`${course.code} ${course.name} ${course.instructor} ${course.section || ''}`).includes(query));
}

function renderScheduleDraft() {
  const visible = visibleScheduleDraft();
  $('scheduleRows').innerHTML = visible.length ? visible.map(({ course, index }) => `<article class="import-course-card" data-course-index="${index}">
    <div class="import-course-top">
      <label class="course-checkbox" title="Bu dersi programa ekle"><input type="checkbox" data-course-selected ${course.selected ? 'checked' : ''}><span></span></label>
      <label>Ders kodu<input data-course-field="code" aria-label="Ders kodu" value="${escapeHtml(course.code)}" placeholder="YBS101"></label>
      <label>Ders adı<input data-course-field="name" aria-label="Ders adı" value="${escapeHtml(course.name)}" placeholder="Ders adı"></label>
      <label>Hoca<input data-course-field="instructor" aria-label="Öğretim görevlisi" value="${escapeHtml(course.instructor)}" placeholder="Hoca adı"></label>
      <button type="button" class="remove-row remove-course" data-remove-course="${index}">Kaldır</button>
    </div>
    <div class="meeting-edit-list"><div class="meeting-edit-heading"><strong>Ders saatleri</strong><button type="button" class="secondary small-button" data-add-meeting="${index}">+ Saat ekle</button></div>
      ${course.meetings.map((meeting, meetingIndex) => `<div class="meeting-edit-row" data-meeting-index="${meetingIndex}">
        <select data-meeting-field="weekday" aria-label="Ders günü"><option value="">Gün</option>${scheduleDayNames.map((day, dayIndex) => `<option value="${dayIndex}" ${String(meeting.weekday) === String(dayIndex) ? 'selected' : ''}>${day}</option>`).join('')}</select>
        <input type="time" data-meeting-field="start_time" aria-label="Başlangıç saati" value="${escapeHtml(meeting.start_time)}">
        <span class="time-separator">–</span>
        <input type="time" data-meeting-field="end_time" aria-label="Bitiş saati" value="${escapeHtml(meeting.end_time)}">
        <input class="room-input" data-meeting-field="room" aria-label="Derslik" value="${escapeHtml(meeting.room)}" placeholder="Derslik / salon">
        <button type="button" class="remove-row" data-remove-meeting="${index}:${meetingIndex}" aria-label="Bu saati kaldır">×</button>
      </div>`).join('')}
    </div>
  </article>`).join('') : '<div class="empty"><strong>Bu aramayla eşleşen ders yok.</strong><span>Bölüm, ders kodu veya ders adını değiştirebilir ya da aramayı temizleyebilirsin.</span></div>';
  $('scheduleRows').oninput = updateScheduleDraftFromInput;
  $('scheduleRows').onchange = updateScheduleDraftFromInput;
  $('scheduleRows').querySelectorAll('[data-remove-course]').forEach(button => button.onclick = () => {
    scheduleDraft.splice(Number(button.dataset.removeCourse), 1);
    renderScheduleDraft();
  });
  $('scheduleRows').querySelectorAll('[data-add-meeting]').forEach(button => button.onclick = () => {
    scheduleDraft[Number(button.dataset.addMeeting)].meetings.push({ weekday: '', start_time: '', end_time: '', room: '' });
    renderScheduleDraft();
  });
  $('scheduleRows').querySelectorAll('[data-remove-meeting]').forEach(button => button.onclick = () => {
    const [courseIndex, meetingIndex] = button.dataset.removeMeeting.split(':').map(Number);
    scheduleDraft[courseIndex].meetings.splice(meetingIndex, 1);
    renderScheduleDraft();
  });
  updateScheduleValidation();
}

function updateScheduleDraftFromInput(event) {
  const courseIndex = Number(event.target.closest('[data-course-index]')?.dataset.courseIndex);
  const course = scheduleDraft[courseIndex];
  if (!course) return;
  if (event.target.matches('[data-course-selected]')) {
    course.selected = event.target.checked;
  } else if (event.target.dataset.courseField) {
    course[event.target.dataset.courseField] = event.target.value;
  } else if (event.target.dataset.meetingField) {
    const meetingIndex = Number(event.target.closest('[data-meeting-index]').dataset.meetingIndex);
    const field = event.target.dataset.meetingField;
    course.meetings[meetingIndex][field] = field === 'weekday' && event.target.value !== '' ? Number(event.target.value) : event.target.value;
  }
  updateScheduleValidation();
}

function updateScheduleValidation() {
  const selected = scheduleDraft.filter(course => course.selected);
  const validTime = meeting => Number.isInteger(meeting.weekday) && meeting.weekday >= 0 && meeting.weekday <= 6 && /^([01]\d|2[0-3]):[0-5]\d$/.test(meeting.start_time) && /^([01]\d|2[0-3]):[0-5]\d$/.test(meeting.end_time) && meeting.end_time > meeting.start_time;
  const invalidCount = selected.filter(course => course.code.trim().length < 2 || course.name.trim().length < 2 || !course.meetings.length || course.meetings.some(meeting => !validTime(meeting))).length;
  const missingTeachers = selected.filter(course => !course.instructor.trim()).length;
  const selectedMeetings = selected.reduce((total, course) => total + course.meetings.length, 0);
  $('applySchedule').disabled = selected.length === 0 || invalidCount > 0;
  $('previewSummary').textContent = `${scheduleDraft.length} ders bulundu · ${selected.length} seçildi · ${selectedMeetings} saat`;
  $('scheduleValidation').textContent = !selected.length ? 'Programa eklemek istediğin derslerin solundaki kutucuğu işaretle.' : invalidCount ? `${invalidCount} seçili derste kod, ad, gün veya saat bilgisi eksik/hatalı; düzeltmeden uygulanamaz.` : missingTeachers ? `${missingTeachers} seçili derste hoca adı bulunamadı. İstersen kaydetmeden önce ekle.` : 'Seçilen dersler hazır. Programını güncellemek için onayla.';
}

function openScheduleImport() {
  $('scheduleFile').value = '';
  $('scheduleStatus').className = 'schedule-status';
  $('scheduleStatus').textContent = scheduleEntries.length ? `Yeni programı uygulayınca mevcut ${scheduleEntries.length} saat güncellenir; ders notların ve görevlerin korunur.` : 'Dosyan yalnızca bu uygulamada işlenir.';
  $('schedulePreview').hidden = true;
  scheduleDraft = [];
  $('scheduleDialog').showModal();
}

async function readScheduleFile() {
  const file = $('scheduleFile').files[0];
  if (!file) {
    $('scheduleStatus').className = 'schedule-status error';
    $('scheduleStatus').textContent = 'Önce PDF veya fotoğraf seç.';
    return;
  }
  $('parseSchedule').disabled = true;
  $('parseSchedule').textContent = 'Program okunuyor…';
  $('scheduleStatus').className = 'schedule-status';
  $('scheduleStatus').textContent = `${file.name} işleniyor. Büyük veya fotoğrafı taranmış PDF’lerde bu biraz sürebilir.`;
  try {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('department', $('departmentSearch').value.trim());
    const result = await api('/api/schedule/parse', { method: 'POST', body: formData });
    scheduleDraft = result.courses.map(course => ({
      code: course.code || '', name: course.name || '', instructor: course.instructor || '', selected: false,
      meetings: course.meetings.map(meeting => ({ weekday: meeting.weekday, start_time: meeting.start_time || '', end_time: meeting.end_time || '', room: meeting.room || '' })),
    }));
    if (!scheduleDraft.length) scheduleDraft.push({ code: '', name: '', instructor: '', selected: false, meetings: [{ weekday: '', start_time: '', end_time: '', room: '' }] });
    $('rawScheduleText').textContent = result.raw_text || 'Okunabilir metin bulunamadı.';
    $('schedulePreview').hidden = false;
    $('scheduleStatus').className = 'schedule-status success';
    $('scheduleStatus').textContent = result.recognized_count ? result.department_matched ? `${result.recognized_count} ders algılandı. Kaydetmeden önce bilgileri gözden geçir.` : `${result.recognized_count} ders bulundu; bölüm adı eşleşmedi, istediğin dersi arayıp seçebilirsin.` : 'Yazı okundu ancak ders kodu bulunamadı. Satırları aşağıya ekleyebilirsin.';
    renderScheduleDraft();
  } catch (error) {
    $('scheduleStatus').className = 'schedule-status error';
    $('scheduleStatus').textContent = error.message;
  } finally {
    $('parseSchedule').disabled = false;
    $('parseSchedule').textContent = 'Programı oku';
  }
}

async function applyScheduleDraft() {
  const byCode = new Map();
  for (const draftCourse of scheduleDraft.filter(course => course.selected)) {
    const code = draftCourse.code.trim().toUpperCase();
    if (!byCode.has(code)) byCode.set(code, { code, name: draftCourse.name.trim(), meetings: [] });
    const course = byCode.get(code);
    if (draftCourse.name.trim().length > course.name.length) course.name = draftCourse.name.trim();
    course.meetings.push(...draftCourse.meetings.map(meeting => ({ weekday: Number(meeting.weekday), start_time: meeting.start_time, end_time: meeting.end_time, instructor: draftCourse.instructor.trim() || null, room: meeting.room.trim() || null })));
  }
  $('applySchedule').disabled = true;
  $('applySchedule').textContent = 'Güncelleniyor…';
  try {
    await api('/api/schedule', { method: 'PUT', body: JSON.stringify({ courses: [...byCode.values()] }) });
    $('scheduleDialog').close();
    await loadDashboard();
  } catch (error) {
    $('scheduleValidation').textContent = error.message;
    $('applySchedule').disabled = false;
  } finally {
    $('applySchedule').textContent = 'Programımı güncelle';
  }
}

async function startApp() {
  const rememberedEmail = localStorage.getItem(OFFLINE_EMAIL_KEY) || '';
  if (rememberedEmail) $('email').value = rememberedEmail;
  if (!token) return;
  try {
    const user = await api('/api/auth/me');
    setLoggedIn(user);
    await loadDashboard();
  } catch (error) {
    if (token && (error.status === 401 || error.status === 403)) {
      token = null;
      localStorage.removeItem('campusflow_token');
    }
    promptOfflineLogin(error.network ? '' : 'Oturum açılamadı. İnternet bağlantısıyla yeniden giriş yapabilir veya kayıtlı çevrimdışı hesabını açabilirsin.');
    if (error.network && rememberedEmail && await window.CampusFlowOffline.hasAccount(rememberedEmail).catch(() => false)) {
      $('authMsg').textContent = 'Bu cihazda şifreli bir kopya var. E-posta ve şifrenle çevrimdışı giriş yapabilirsin.';
    } else if (!error.network) {
      $('authMsg').textContent = error.message;
    }
  }
}

$('authSwitch').onclick = () => setAuthMode(authMode === 'login' ? 'register' : 'login');
$('syncOfflineData').onclick = syncOfflineData;
window.addEventListener('offline', () => {
  if (window.CampusFlowOffline?.ready) {
    activateOfflineMode();
    if (['studyPage', 'messagesPage', 'aiSettingsPage', 'adminPage'].includes(activePageId)) setPage('homePage');
    updateConnectionBanner();
  } else if ($('app') && !$('app').hidden) {
    promptOfflineLogin();
  }
});
window.addEventListener('online', () => {
  if (window.CampusFlowOffline?.ready) syncOfflineData();
  else updateConnectionBanner();
});
$('loginForm').onsubmit = async event => {
  event.preventDefault();
  $('authMsg').textContent = '';
  const email = $('email').value.trim();
  const password = $('password').value;
  localStorage.setItem(OFFLINE_EMAIL_KEY, email);
  const registering = authMode === 'register';
  const submitButton = $('authSubmit');
  let accountCreated = false;
  submitButton.disabled = true;
  try {
    if (registering) {
      await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, full_name: $('name').value.trim(), password }) });
      accountCreated = true;
    }
    const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    token = result.access_token;
    localStorage.setItem('campusflow_token', token);
    const user = await api('/api/auth/me');
    offlineMode = false;
    offlineSetupIssue = '';
    let syncIssue = '';
    try {
      const prepared = await window.CampusFlowOffline.prepareOnline(email, password, user);
      if (prepared.pending) {
        try { await window.CampusFlowOffline.syncPending(token); }
        catch (error) { offlineMode = true; syncIssue = error.message; }
      }
    } catch (error) {
      offlineSetupIssue = error.message;
    }
    setLoggedIn(user);
    await loadDashboard();
    await loadRoutine();
    await loadNotes();
    if (syncIssue) updateConnectionBanner(syncIssue);
    else updateConnectionBanner();
  } catch (error) {
    let displayError = error;
    if (!registering && error.network && window.CampusFlowOffline) {
      try {
        const user = await window.CampusFlowOffline.unlockOffline(email, password);
        offlineMode = true;
        offlineSetupIssue = '';
        token = null;
        setLoggedIn(user);
        await loadDashboard();
        await loadRoutine();
        await loadNotes();
        updateConnectionBanner();
        $('authMsg').textContent = '';
        return;
      } catch (offlineError) {
        displayError = offlineError;
      }
    }
    if (!error.network) {
      token = null;
      localStorage.removeItem('campusflow_token');
    }
    $('authMsg').className = '';
    $('authMsg').textContent = registering && error.network
      ? 'Yeni hesap oluşturmak için internet bağlantısı gerekiyor.'
      : displayError === error ? authErrorMessage(error, registering, accountCreated) : displayError.message;
  } finally {
    submitButton.disabled = false;
  }
};

$('addCourse').onclick = () => { $('courseForm').reset(); $('courseForm').querySelector('.formMsg').textContent = ''; $('courseDialog').showModal(); };
$('addTask').onclick = () => openTaskDialog();
$('quickAddTask').onclick = () => openTaskDialog();
$('openScheduleImport').onclick = openScheduleImport;
$('parseSchedule').onclick = readScheduleFile;
$('addScheduleRow').onclick = () => {
  $('departmentSearch').value = '';
  scheduleDraft.push({ code: '', name: '', instructor: '', selected: true, meetings: [{ weekday: '', start_time: '', end_time: '', room: '' }] });
  renderScheduleDraft();
  $('scheduleRows .import-course-card:last-child [data-course-field="code"]').focus();
};
$('departmentSearch').oninput = () => { if (!$('schedulePreview').hidden) renderScheduleDraft(); };
$('selectAllCourses').onclick = () => { visibleScheduleDraft().forEach(({ course }) => course.selected = true); renderScheduleDraft(); };
$('clearCourseSelection').onclick = () => { scheduleDraft.forEach(course => course.selected = false); renderScheduleDraft(); };
$('applySchedule').onclick = applyScheduleDraft;
$('taskFilter').onchange = renderTasks;
document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => button.closest('dialog').close());

$('courseForm').onsubmit = async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const message = event.currentTarget.querySelector('.formMsg');
  message.textContent = '';
  try {
    await api('/api/courses', { method: 'POST', body: JSON.stringify({ code: form.get('code').trim(), name: form.get('name').trim(), credits: Number(form.get('credits')), target_grade: Number(form.get('target_grade')) }) });
    $('courseDialog').close();
    await loadDashboard();
  } catch (error) { message.textContent = error.message; }
};

$('taskForm').onsubmit = async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const message = event.currentTarget.querySelector('.formMsg');
  message.textContent = '';
  const dueAt = form.get('due_at');
  const payload = { title: form.get('title').trim(), description: form.get('description').trim() || null, course_id: form.get('course_id') ? Number(form.get('course_id')) : null, priority: Number(form.get('priority')), due_at: dueAt ? new Date(dueAt).toISOString() : null };
  try {
    if (editingTaskId) await api(`/api/tasks/${editingTaskId}`, { method: 'PATCH', body: JSON.stringify(payload) });
    else await api('/api/tasks', { method: 'POST', body: JSON.stringify(payload) });
    $('taskDialog').close();
    await loadDashboard();
  } catch (error) { message.textContent = error.message; }
};

$('gradeForm').onsubmit = async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const message = event.currentTarget.querySelector('.formMsg');
  message.textContent = '';
  try {
    const payload = { name: form.get('name').trim(), score: Number(form.get('score')), weight: Number(form.get('weight')) };
    const path = `/api/courses/${addingGradeTo}/grades${editingGradeId ? `/${editingGradeId}` : ''}`;
    await api(path, { method: editingGradeId ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    $('gradeDialog').close();
    await loadDashboard();
  } catch (error) { message.textContent = error.message; }
};

document.querySelectorAll('.nav-tab').forEach(button => button.onclick = () => setPage(button.dataset.page));
$('refreshRoutine').onclick = loadRoutine;
document.querySelectorAll('[data-focus-minutes]').forEach(button => button.onclick = () => {
  if (focusTimerState) return;
  selectedFocusMinutes = Number(button.dataset.focusMinutes);
  $('focusTimerStatus').classList.remove('routine-message-error');
  renderFocusTimer();
});
$('startFocusTimer').onclick = startOrResumeFocusTimer;
$('pauseFocusTimer').onclick = pauseFocusTimer;
$('finishFocusTimer').onclick = finishFocusTimer;
$('focusSessionNote').oninput = () => {
  if (focusTimerState) {
    focusTimerState.note = $('focusSessionNote').value.trim();
    persistFocusTimer();
  }
};
$('weeklyGoalForm').onsubmit = async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api('/api/routine/goal', { method: 'PUT', body: JSON.stringify({ weekly_goal_minutes: Number($('weeklyGoalInput').value) }) });
    await loadRoutine();
  } catch (error) { alert(error.message); }
  finally { button.disabled = false; }
};
$('quickSessionForm').onsubmit = async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api('/api/routine/sessions', { method: 'POST', body: JSON.stringify({ duration_minutes: Number($('quickSessionMinutes').value), course_id: $('quickSessionCourse').value ? Number($('quickSessionCourse').value) : null, note: $('quickSessionNote').value.trim() || null }) });
    $('quickSessionNote').value = '';
    await loadRoutine();
  } catch (error) { alert(error.message); }
  finally { button.disabled = false; }
};
$('attendanceCourse').onchange = () => {
  const course = routineOverview?.attendance_by_course.find(item => String(item.course_id) === $('attendanceCourse').value);
  if (course) $('allowedAbsences').value = course.allowed_absences;
};
$('attendanceForm').onsubmit = async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  const message = $('attendanceStatusMessage');
  message.className = '';
  message.textContent = '';
  button.disabled = true;
  try {
    await api('/api/routine/attendance', { method: 'POST', body: JSON.stringify({ course_id: Number($('attendanceCourse').value), session_date: $('attendanceDate').value, status: $('attendanceStatus').value, allowed_absences: Number($('allowedAbsences').value), note: $('attendanceNote').value.trim() || null }) });
    message.className = 'routine-message-success';
    message.textContent = '✓ Yoklama kaydedildi.';
    $('attendanceNote').value = '';
    await loadRoutine();
  } catch (error) {
    message.className = 'routine-message-error';
    message.textContent = error.message;
  } finally { button.disabled = false; }
};
$('portalForm').onsubmit = event => {
  event.preventDefault();
  const value = $('portalUrl').value.trim();
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Güvenlik için geçerli bir http veya https okul adresi gir.');
    localStorage.setItem(`campusflow_portal_${currentUserId}`, url.href);
    $('portalUrl').value = url.href;
    $('documentStatus').className = 'schedule-status success';
    $('documentStatus').textContent = 'Okul portal adresi bu tarayıcıda hesabın için kaydedildi.';
  } catch (error) {
    $('documentStatus').className = 'schedule-status error';
    $('documentStatus').textContent = error.message || 'Geçerli bir okul portal adresi gir.';
  }
};
$('openPortal').onclick = () => {
  const value = $('portalUrl').value.trim() || localStorage.getItem(`campusflow_portal_${currentUserId}`) || '';
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error();
    window.open(url.href, '_blank', 'noopener,noreferrer');
  } catch {
    $('documentStatus').className = 'schedule-status error';
    $('documentStatus').textContent = 'Önce geçerli okul portal adresini yazıp kaydet.';
  }
};
$('documentForm').onsubmit = async event => {
  event.preventDefault();
  const file = $('studyPdf').files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  formData.append('title', $('documentTitle').value.trim());
  $('uploadStudyPdf').disabled = true;
  $('uploadStudyPdf').textContent = 'PDF ekleniyor…';
  $('documentStatus').className = 'schedule-status';
  $('documentStatus').textContent = 'PDF metni çıkarılıp kütüphanene kaydediliyor. Özeti sonra ayrı başlatabilirsin.';
  try {
    await api('/api/study/documents', { method: 'POST', body: formData });
    $('documentForm').reset();
    $('documentStatus').className = 'schedule-status success';
    $('documentStatus').textContent = '✓ PDF hesabına kaydedildi. PDF’yi hemen açabilir, istersen özetini ayrı başlatabilirsin.';
    await loadDocuments();
  } catch (error) {
    $('documentStatus').className = 'schedule-status error';
    $('documentStatus').textContent = error.message;
  } finally {
    $('uploadStudyPdf').disabled = false;
    $('uploadStudyPdf').textContent = 'PDF’yi ekle';
  }
};
$('refreshDocuments').onclick = loadDocuments;
$('newNote').onclick = () => { $('quickNoteForm').reset(); $('quickNoteForm').querySelector('.formMsg').textContent = ''; $('quickNoteDialog').showModal(); };
$('quickNoteForm').onsubmit = async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const message = event.currentTarget.querySelector('.formMsg');
  try {
    await api('/api/study/notes', { method: 'POST', body: JSON.stringify({ title: form.get('title').trim(), body: form.get('body').trim() }) });
    $('quickNoteDialog').close();
    await loadNotes();
  } catch (error) { message.textContent = error.message; }
};
$('openConversationForm').onsubmit = event => {
  event.preventDefault();
  openConversation($('recipientEmail').value);
};
$('audioCall').onclick = () => startCall('audio');
$('videoCall').onclick = () => startCall('video');
$('recordVoice').onclick = toggleVoiceRecording;
$('acceptCall').onclick = acceptIncomingCall;
$('declineCall').onclick = () => {
  if (currentCall?.id) sendRealtime({ type: 'call_reject', call_id: currentCall.id });
  finishLocalCall();
};
$('hangupCall').onclick = () => {
  if (currentCall?.id) sendRealtime({ type: 'call_end', call_id: currentCall.id });
  finishLocalCall();
};
$('callClose').onclick = $('hangupCall').onclick;
$('callDialog').addEventListener('cancel', event => { event.preventDefault(); $('hangupCall').click(); });
$('toggleMicrophone').onclick = () => {
  const track = currentCall?.stream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  $('toggleMicrophone').textContent = track.enabled ? 'Mikrofonu kapat' : 'Mikrofonu aç';
};
$('toggleCamera').onclick = () => {
  const track = currentCall?.stream?.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  $('toggleCamera').textContent = track.enabled ? 'Kamerayı kapat' : 'Kamerayı aç';
};
$('refreshContacts').onclick = loadContacts;
$('refreshActiveUsers').onclick = loadActiveUsers;
$('messageFile').onchange = () => {
  pendingVoiceFile = null;
  resetVoicePreview();
  $('removeVoice').hidden = true;
  $('attachmentName').textContent = $('messageFile').files[0]?.name || '';
  $('recordingStatus').textContent = 'Dosya eklendi. Mesajınla birlikte gönderebilirsin.';
};
$('removeVoice').onclick = () => {
  pendingVoiceFile = null;
  resetVoicePreview();
  $('removeVoice').hidden = true;
  $('attachmentName').textContent = '';
  $('recordingStatus').textContent = 'Ses kaydı kaldırıldı.';
};
$('messageBody').addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (!$('sendMessage').disabled) $('messageForm').requestSubmit();
});
$('messageForm').onsubmit = async event => {
  event.preventDefault();
  if (!activeConversationEmail) return;
  if (voiceRecorder && voiceRecorder.state !== 'inactive') return alert('Önce ses kaydını bitir.');
  const recipientEmail = activeConversationEmail;
  const formData = new FormData();
  formData.append('recipient_email', recipientEmail);
  formData.append('body', $('messageBody').value.trim());
  const file = $('messageFile').files[0] || pendingVoiceFile;
  if (file) formData.append('file', file);
  $('sendMessage').disabled = true;
  try {
    await api('/api/messages', { method: 'POST', body: formData });
    playMessageNotification('sent');
    contactUnreadCounts.set(recipientEmail, contactUnreadCounts.get(recipientEmail) ?? 0);
    $('messageBody').value = '';
    $('messageFile').value = '';
    pendingVoiceFile = null;
    resetVoicePreview();
    $('removeVoice').hidden = true;
    $('attachmentName').textContent = '';
    $('recordingStatus').textContent = 'Enter ile gönder · Shift+Enter ile yeni satır · Dosya ve ses kaydı en fazla 12 MB';
    await refreshConversation(recipientEmail);
  } catch (error) { alert(error.message); }
  finally { $('sendMessage').disabled = false; }
};
$('assistantLauncher').onclick = () => toggleAssistant($('assistantPanel').hidden);
$('closeAssistant').onclick = () => toggleAssistant(false);
$('assistantForm').onsubmit = async event => {
  event.preventDefault();
  const button = $('askAssistant');
  button.disabled = true;
  button.textContent = 'Materyallerinde yanıt aranıyor…';
  $('assistantAnswer').textContent = '';
  $('assistantSources').replaceChildren();
  $('assistantNoteForm').hidden = true;
  try {
    const result = await api('/api/study/assistant/ask', { method: 'POST', body: JSON.stringify({ question: $('assistantQuestion').value.trim() }) });
    assistantAnswer = result.answer;
    $('assistantAnswer').textContent = `${assistantAnswer}${result.privacy_note ? `\n\n${result.privacy_note}` : ''}`;
    renderAssistantSources(result.sources || [], result.privacy_note, result.used_materials);
    const mode = result.provider === 'cloud' ? 'Bulut AI' : 'Yerel AI';
    $('assistantModeFooter').textContent = `Son yanıt: ${mode} · ${result.model}${result.used_materials ? ' · kişisel materyaller kullanıldı' : ''}`;
    $('assistantNoteTitle').value = $('assistantQuestion').value.trim().slice(0, 180);
    $('assistantNoteForm').hidden = false;
    await loadAIUsage();
  } catch (error) { $('assistantAnswer').textContent = error.message; }
  finally { button.disabled = false; button.textContent = 'Yanıtla'; }
};
$('assistantNoteForm').onsubmit = async event => {
  event.preventDefault();
  try {
    await api('/api/study/notes', { method: 'POST', body: JSON.stringify({ title: $('assistantNoteTitle').value.trim(), body: assistantAnswer }) });
    $('assistantNoteForm').hidden = true;
    $('assistantAnswer').textContent = '✓ Yanıt AI notlarına kaydedildi. Notlarım bölümünden görebilirsin.';
    await loadNotes();
  } catch (error) { $('assistantAnswer').textContent = error.message; }
};
$('saveQuickNote').onclick = async () => {
  const title = $('quickNoteTitle').value.trim();
  const body = $('quickNoteBody').value.trim();
  if (!title || !body) { $('quickNoteBody').focus(); return; }
  try {
    await api('/api/study/notes', { method: 'POST', body: JSON.stringify({ title, body }) });
    $('quickNoteTitle').value = '';
    $('quickNoteBody').value = '';
    $('assistantAnswer').textContent = '✓ Not AI notlarıma kaydedildi.';
    await loadNotes();
  } catch (error) { $('assistantAnswer').textContent = error.message; }
};
$('aiSettingsForm').onsubmit = async event => { event.preventDefault(); await saveAISettings(); };
$('aiProvider').onchange = setAIProviderVisibility;
$('checkAIConnection').onclick = async () => {
  if (!await saveAISettings(true)) return;
  $('aiSettingsStatus').className = 'ai-status';
  $('aiSettingsStatus').textContent = 'Bağlantı kontrol ediliyor…';
  await loadAIStatus();
};
$('testAI').onclick = runAITest;
$('refreshLocalModels').onclick = refreshLocalModels;
$('copyModelCommand').onclick = async () => {
  try {
    await navigator.clipboard.writeText('ollama pull qwen2.5:3b');
    $('aiSettingsStatus').className = 'ai-status good';
    $('aiSettingsStatus').textContent = '✓ Daha az bellek kullanan modeli indirmek için `ollama pull qwen2.5:3b` komutu kopyalandı.';
  } catch {
    $('aiSettingsStatus').className = 'ai-status';
    $('aiSettingsStatus').textContent = 'PowerShell’i açıp `ollama pull qwen2.5:3b` komutunu çalıştır.';
  }
};
$('exportAccountData').onclick = exportAccountData;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
$('closePdfReader').onclick = () => $('pdfReaderDialog').close();
$('pdfReaderDownload').onclick = () => {
  const item = studyDocuments.find(document => document.id === pdfReaderDocumentId);
  if (item) downloadProtectedFile(`/api/study/documents/${item.id}/file`, item.filename);
};
$('pdfPreviousPage').onclick = () => goToPdfReaderPage(pdfReaderCurrentPage - 1);
$('pdfNextPage').onclick = () => goToPdfReaderPage(pdfReaderCurrentPage + 1);
$('pdfReaderToolbar').onsubmit = event => {
  event.preventDefault();
  goToPdfReaderPage(Number($('pdfPageNumber').value));
};
$('pdfReaderStage').addEventListener('scroll', () => {
  const stage = $('pdfReaderStage');
  const threshold = stage.getBoundingClientRect().top + 48;
  let visiblePage = 1;
  for (const section of $('pdfPageList').children) {
    if (section.getBoundingClientRect().top > threshold) break;
    visiblePage = Number(section.dataset.pdfPage);
  }
  if (visiblePage !== pdfReaderCurrentPage) {
    pdfReaderCurrentPage = visiblePage;
    updatePdfReaderControls();
    evictDistantPdfReaderPages(visiblePage);
  }
}, { passive: true });
$('pdfReaderDialog').addEventListener('close', closePdfReader);

if (token) startApp();
else setAuthMode('login');
