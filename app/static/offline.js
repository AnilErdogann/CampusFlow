(() => {
  'use strict';

  const DB_NAME = 'campusflow-offline-v1';
  const STORE_NAME = 'accounts';
  const ITERATIONS = 310000;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let account = null;
  let cryptoKey = null;
  let state = null;
  let persistChain = Promise.resolve();

  function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
  }

  function copy(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function bytesToBase64(bytes) {
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
  }

  function base64ToBytes(value) {
    const binary = atob(value);
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  }

  function equalBytes(left, right) {
    if (left.length !== right.length) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
    return difference === 0;
  }

  function openDatabase() {
    if (!('indexedDB' in window)) throw new Error('Bu tarayıcı çevrimdışı veri saklamayı desteklemiyor.');
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: 'email' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Çevrimdışı kasa açılamadı.'));
    });
  }

  async function readAccount(email) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(normalizeEmail(email));
      request.onsuccess = () => { const result = request.result || null; database.close(); resolve(result); };
      request.onerror = () => { database.close(); reject(request.error || new Error('Kayıtlı hesap okunamadı.')); };
    });
  }

  async function writeAccount(record) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(record);
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => { database.close(); reject(transaction.error || new Error('Çevrimdışı kayıt kaydedilemedi.')); };
      transaction.onabort = () => { database.close(); reject(transaction.error || new Error('Çevrimdışı kayıt kaydedilemedi.')); };
    });
  }

  async function deriveCredentials(password, salt) {
    if (!window.crypto?.subtle) {
      throw new Error('Güvenli çevrimdışı giriş için HTTPS veya localhost bağlantısı gerekiyor.');
    }
    const passwordKey = await crypto.subtle.importKey(
      'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
    );
    const bits = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, passwordKey, 512
    ));
    const encryptionKey = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
    return { encryptionKey, verifier: bits.slice(32) };
  }

  async function encryptSnapshot(snapshot, email, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(email) },
      key,
      encoder.encode(JSON.stringify(snapshot))
    );
    return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
  }

  async function decryptSnapshot(record, key) {
    const cleartext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(record.iv), additionalData: encoder.encode(record.email) },
      key,
      base64ToBytes(record.ciphertext)
    );
    return JSON.parse(decoder.decode(cleartext));
  }

  function emptyState(user) {
    return {
      user,
      courses: [],
      tasks: [],
      schedule: [],
      routine: null,
      notes: [],
      pendingOps: [],
      counters: { courses: -1, tasks: -1, grades: -1, meetings: -1, sessions: -1, attendance: -1, notes: -1 },
      lastSyncedAt: new Date().toISOString(),
    };
  }

  function restoreCounters() {
    state.counters ||= {};
    for (const name of ['courses', 'tasks', 'grades', 'meetings', 'sessions', 'attendance', 'notes']) {
      state.counters[name] ??= -1;
    }
    state.pendingOps ||= [];
    state.courses ||= [];
    state.tasks ||= [];
    state.schedule ||= [];
    state.notes ||= [];
    for (const course of state.courses) course.grades ||= [];
    state.routine ||= newRoutine();
  }

  function lock() {
    account = null;
    cryptoKey = null;
    state = null;
  }

  async function prepareOnline(email, password, user) {
    lock();
    const normalized = normalizeEmail(email);
    if (!normalized || !password) throw new Error('Çevrimdışı hesap hazırlanamadı.');
    const existing = await readAccount(normalized);

    if (existing?.salt && existing?.verifier && existing?.iv && existing?.ciphertext) {
      try {
        const salt = base64ToBytes(existing.salt);
        const keys = await deriveCredentials(password, salt);
        if (!equalBytes(keys.verifier, base64ToBytes(existing.verifier))) {
          throw new Error('Bu cihazdaki çevrimdışı kopya başka bir şifreyle korunuyor. Mevcut veriler silinmedi; çevrimdışı açmak için önceki şifreni kullan.');
        }
        state = await decryptSnapshot(existing, keys.encryptionKey);
        restoreCounters();
        state.user = user;
        account = { email: normalized, salt: existing.salt, verifier: existing.verifier };
        cryptoKey = keys.encryptionKey;
        return { restored: true, pending: state.pendingOps.length };
      } catch (error) {
        if (error.message.includes('başka bir şifreyle')) throw error;
        throw new Error('Bu cihazdaki çevrimdışı kayıt açılamadı. Yerel veriler korunuyor; şifreni kontrol et.');
      }
    } else if (existing) {
      throw new Error('Bu e-posta için okunamayan bir çevrimdışı kayıt bulundu. Mevcut yerel veri korunuyor.');
    }

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const keys = await deriveCredentials(password, salt);
    account = { email: normalized, salt: bytesToBase64(salt), verifier: bytesToBase64(keys.verifier) };
    cryptoKey = keys.encryptionKey;
    state = emptyState(user);
    return { restored: false, pending: 0 };
  }

  async function unlockOffline(email, password) {
    lock();
    const normalized = normalizeEmail(email);
    const record = await readAccount(normalized);
    if (!record?.salt || !record?.verifier || !record?.ciphertext) {
      throw new Error('Bu cihazda kayıtlı çevrimdışı hesap yok. İnternet açıkken bu hesapla bir kez giriş yap.');
    }
    try {
      const keys = await deriveCredentials(password, base64ToBytes(record.salt));
      if (!equalBytes(keys.verifier, base64ToBytes(record.verifier))) {
        throw new Error('E-posta veya şifre hatalı.');
      }
      const snapshot = await decryptSnapshot(record, keys.encryptionKey);
      if (normalizeEmail(snapshot.user?.email) !== normalized) throw new Error('Çevrimdışı hesap doğrulanamadı.');
      state = snapshot;
      restoreCounters();
      account = { email: normalized, salt: record.salt, verifier: record.verifier };
      cryptoKey = keys.encryptionKey;
      return copy(state.user);
    } catch (error) {
      if (error.message === 'E-posta veya şifre hatalı.') throw error;
      throw new Error('Çevrimdışı hesap açılamadı. Şifreni kontrol et veya internet bağlantısıyla yeniden giriş yap.');
    }
  }

  function persist() {
    if (!account || !cryptoKey || !state) return Promise.resolve();
    const snapshot = copy(state);
    const currentAccount = { ...account };
    const currentKey = cryptoKey;
    const save = async () => {
      const encrypted = await encryptSnapshot(snapshot, currentAccount.email, currentKey);
      await writeAccount({ ...currentAccount, ...encrypted, iterations: ITERATIONS, updatedAt: new Date().toISOString() });
    };
    persistChain = persistChain.catch(() => {}).then(save);
    return persistChain;
  }

  function updateSnapshot(snapshot) {
    if (!state) return;
    const pendingOps = state.pendingOps || [];
    const counters = state.counters || {};
    state = { ...state, ...copy(snapshot), pendingOps, counters };
    restoreCounters();
  }

  function nextId(kind) {
    const id = state.counters[kind] ?? -1;
    state.counters[kind] = id - 1;
    return id;
  }

  function makeError(message, status = 0) {
    const error = new Error(message);
    error.status = status;
    return error;
  }

  function requiresInternet() {
    const error = makeError('Bu özellik internet bağlantısı gerektiriyor. Bağlantı geldiğinde yeniden dene.');
    error.requiresInternet = true;
    return error;
  }

  function courseById(id) {
    return state.courses.find(course => course.id === Number(id));
  }

  function refreshCourse(course) {
    const weight = course.grades.reduce((sum, grade) => sum + Number(grade.weight || 0), 0);
    const average = weight ? course.grades.reduce((sum, grade) => sum + Number(grade.score) * Number(grade.weight), 0) / weight : null;
    course.analytics = {
      course_id: course.id,
      code: course.code,
      name: course.name,
      weighted_average: average === null ? null : Math.round(average * 100) / 100,
      target_grade: course.target_grade,
      progress_percent: average === null ? 0 : Math.round(Math.min(average / Math.max(course.target_grade, 1) * 100, 100) * 100) / 100,
    };
  }

  function getDashboard() {
    const tasks = state.tasks;
    const grades = state.courses.flatMap(course => course.grades || []);
    const totalWeight = grades.reduce((sum, grade) => sum + Number(grade.weight || 0), 0);
    const average = totalWeight ? grades.reduce((sum, grade) => sum + Number(grade.score) * Number(grade.weight), 0) / totalWeight : null;
    const completed = tasks.filter(task => task.status === 'done').length;
    const overdue = tasks.filter(task => task.status !== 'done' && task.due_at && new Date(task.due_at) < new Date()).length;
    return {
      total_courses: state.courses.length,
      total_tasks: tasks.length,
      completed_tasks: completed,
      completion_rate: tasks.length ? Math.round(completed / tasks.length * 10000) / 100 : 0,
      overdue_tasks: overdue,
      average_grade: average === null ? null : Math.round(average * 100) / 100,
    };
  }

  function localDate(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function dateFromIso(value) {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day);
  }

  function newRoutine() {
    const today = dateFromIso(localDate());
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    const weekByDay = {};
    for (let offset = 0; offset < 7; offset += 1) {
      const date = new Date(weekStart);
      date.setDate(weekStart.getDate() + offset);
      weekByDay[localDate(date)] = 0;
    }
    return {
      today: localDate(today),
      week_start: localDate(weekStart),
      weekly_goal_minutes: 300,
      week_minutes: 0,
      today_minutes: 0,
      streak_days: 0,
      week_by_day: weekByDay,
      sessions: [],
      attendance_by_course: [],
      attendance_records: [],
    };
  }

  function refreshRoutine() {
    state.routine ||= newRoutine();
    const routine = state.routine;
    const today = dateFromIso(localDate());
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    const preserveWeek = routine.week_start === localDate(weekStart);
    const weekByDay = {};
    for (let offset = 0; offset < 7; offset += 1) {
      const date = new Date(weekStart);
      date.setDate(weekStart.getDate() + offset);
      const key = localDate(date);
      weekByDay[key] = preserveWeek ? Number(routine.week_by_day?.[key] || 0) : 0;
    }
    let todayMinutes = preserveWeek ? Number(weekByDay[localDate(today)] || 0) : 0;
    let weekMinutes = preserveWeek ? Number(routine.week_minutes || 0) : 0;
    if (!preserveWeek) {
      for (const session of routine.sessions || []) {
        const date = session.date;
        if (Object.hasOwn(weekByDay, date)) {
          weekByDay[date] += session.duration_minutes;
          weekMinutes += session.duration_minutes;
          if (date === localDate(today)) todayMinutes += session.duration_minutes;
        }
      }
    }

    const activeDates = new Set((routine.sessions || []).map(session => session.date).filter(date => date <= localDate(today)));
    let streak = preserveWeek ? Number(routine.streak_days || 0) : 0;
    if (!preserveWeek) {
      let streakDate = new Date(today);
      if (!activeDates.has(localDate(streakDate))) streakDate.setDate(streakDate.getDate() - 1);
      while (activeDates.has(localDate(streakDate))) {
        streak += 1;
        streakDate.setDate(streakDate.getDate() - 1);
      }
    }

    const records = routine.attendance_records || [];
    const existingSummaries = new Map((routine.attendance_by_course || []).map(item => [item.course_id, item]));
    routine.attendance_by_course = state.courses.map(course => {
      const courseRecords = records.filter(record => record.course_id === course.id);
      const existing = existingSummaries.get(course.id);
      const attended = existing?.attended ?? courseRecords.filter(record => record.status === 'attended').length;
      const absent = existing?.absent ?? courseRecords.filter(record => record.status === 'absent').length;
      const excused = existing?.excused ?? courseRecords.filter(record => record.status === 'excused').length;
      const allowed = existing?.allowed_absences ?? 3;
      return {
        course_id: course.id,
        course_code: course.code,
        course_name: course.name,
        attended,
        absent,
        excused,
        total: attended + absent + excused,
        allowed_absences: allowed,
        risk: allowed ? absent >= Math.max(1, allowed - 1) : absent > 0,
      };
    });
    routine.today = localDate(today);
    routine.week_start = localDate(weekStart);
    routine.weekly_goal_minutes ??= 300;
    routine.week_minutes = weekMinutes;
    routine.today_minutes = todayMinutes;
    routine.streak_days = streak;
    routine.week_by_day = weekByDay;
    routine.sessions = (routine.sessions || []).slice().sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id).slice(0, 20);
    routine.attendance_records = records.slice().sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id).slice(0, 30);
    return routine;
  }

  function enqueue(method, path, body, localType = null, localId = null) {
    state.pendingOps.push({ method, path, body: body === undefined ? null : copy(body), localType, localId });
  }

  async function commitMutation(previous, result, operation) {
    if (operation) enqueue(operation.method, operation.path, operation.body, operation.localType, operation.localId);
    try {
      await persist();
      return result === null ? null : copy(result);
    } catch (error) {
      state = previous;
      throw makeError(`Yerel kayıt kaydedilemedi: ${error.message}`);
    }
  }

  async function localApi(path, options = {}) {
    if (!state) throw requiresInternet();
    const method = (options.method || 'GET').toUpperCase();
    const url = new URL(path, location.origin);
    const route = url.pathname;
    let body = {};
    if (options.body) {
      if (options.body instanceof FormData) throw requiresInternet();
      try { body = JSON.parse(options.body); } catch { throw makeError('Çevrimdışı işlem verisi okunamadı.'); }
    }

    if (method === 'GET' && route === '/api/auth/me') return copy(state.user);
    if (method === 'GET' && route === '/api/dashboard') return getDashboard();
    if (method === 'GET' && route === '/api/courses') {
      return copy(state.courses.map(({ analytics, grades, ...course }) => course));
    }
    if (method === 'GET' && route === '/api/tasks') return copy(state.tasks);
    if (method === 'GET' && route === '/api/schedule') return copy(state.schedule);
    if (method === 'GET' && route === '/api/routine/overview') return copy(refreshRoutine());
    if (method === 'GET' && route === '/api/study/notes') return copy(state.notes);

    let match = route.match(/^\/api\/courses\/(\-?\d+)\/analytics$/);
    if (method === 'GET' && match) {
      const course = courseById(match[1]);
      if (!course) throw makeError('Ders bulunamadı.', 404);
      refreshCourse(course);
      return copy(course.analytics);
    }
    match = route.match(/^\/api\/courses\/(\-?\d+)\/grades$/);
    if (method === 'GET' && match) {
      const course = courseById(match[1]);
      if (!course) throw makeError('Ders bulunamadı.', 404);
      return copy(course.grades);
    }

    const previous = copy(state);
    if (method === 'POST' && route === '/api/courses') {
      const course = {
        id: nextId('courses'),
        code: body.code.trim().toUpperCase(),
        name: body.name.trim(),
        credits: body.credits,
        target_grade: body.target_grade ?? 70,
        course_note: null,
        grades: [],
      };
      if (state.courses.some(item => item.code.toUpperCase() === course.code)) throw makeError('Bu ders kodu zaten kayıtlı.', 409);
      state.courses.push(course);
      refreshCourse(course);
      return commitMutation(previous, course, { method, path: route, body, localType: 'courses', localId: course.id });
    }

    match = route.match(/^\/api\/courses\/(\-?\d+)\/note$/);
    if (method === 'PUT' && match) {
      const course = courseById(match[1]);
      if (!course) throw makeError('Ders bulunamadı.', 404);
      course.course_note = body.course_note?.trim() || null;
      for (const entry of state.schedule) if (entry.course_id === course.id) entry.course_note = course.course_note;
      return commitMutation(previous, course, { method, path: route, body });
    }

    match = route.match(/^\/api\/courses\/(\-?\d+)\/grades$/);
    if (method === 'POST' && match) {
      const course = courseById(match[1]);
      if (!course) throw makeError('Ders bulunamadı.', 404);
      const remaining = Math.max(0, 100 - course.grades.reduce((sum, grade) => sum + grade.weight, 0));
      if (body.weight > remaining + 1e-6) throw makeError(`Bu derste en fazla %${remaining.toLocaleString('tr-TR')} ağırlık kalmış.`, 422);
      const grade = { id: nextId('grades'), course_id: course.id, name: body.name.trim(), score: body.score, weight: body.weight };
      course.grades.push(grade);
      refreshCourse(course);
      return commitMutation(previous, grade, { method, path: route, body, localType: 'grades', localId: grade.id });
    }

    match = route.match(/^\/api\/courses\/(\-?\d+)\/grades\/(\-?\d+)$/);
    if (match && ['PUT', 'DELETE'].includes(method)) {
      const course = courseById(match[1]);
      const gradeIndex = course?.grades.findIndex(grade => grade.id === Number(match[2])) ?? -1;
      if (!course || gradeIndex < 0) throw makeError('Değerlendirme bulunamadı.', 404);
      const grade = course.grades[gradeIndex];
      if (method === 'DELETE') {
        course.grades.splice(gradeIndex, 1);
        refreshCourse(course);
        return commitMutation(previous, null, { method, path: route });
      }
      const otherWeight = course.grades.reduce((sum, item) => sum + (item.id === grade.id ? 0 : item.weight), 0);
      if (body.weight > Math.max(0, 100 - otherWeight) + 1e-6) throw makeError('Değerlendirme ağırlıkları toplamı %100’ü aşamaz.', 422);
      Object.assign(grade, { name: body.name.trim(), score: body.score, weight: body.weight });
      refreshCourse(course);
      return commitMutation(previous, grade, { method, path: route, body });
    }

    if (method === 'POST' && route === '/api/tasks') {
      if (body.course_id && !courseById(body.course_id)) throw makeError('Ders bulunamadı.', 400);
      const task = { id: nextId('tasks'), title: body.title.trim(), description: body.description || null, course_id: body.course_id || null, priority: body.priority || 3, due_at: body.due_at || null, status: 'todo' };
      state.tasks.push(task);
      return commitMutation(previous, task, { method, path: route, body, localType: 'tasks', localId: task.id });
    }
    match = route.match(/^\/api\/tasks\/(\-?\d+)$/);
    if (match && ['PATCH', 'DELETE'].includes(method)) {
      const taskIndex = state.tasks.findIndex(task => task.id === Number(match[1]));
      if (taskIndex < 0) throw makeError('Görev bulunamadı.', 404);
      if (method === 'DELETE') {
        state.tasks.splice(taskIndex, 1);
        return commitMutation(previous, null, { method, path: route });
      }
      if (body.course_id && !courseById(body.course_id)) throw makeError('Ders bulunamadı.', 400);
      Object.assign(state.tasks[taskIndex], body);
      return commitMutation(previous, state.tasks[taskIndex], { method, path: route, body });
    }

    if (method === 'PUT' && route === '/api/schedule') {
      const byCode = new Map(state.courses.map(course => [course.code.toUpperCase(), course]));
      const nextSchedule = [];
      let meetings = 0;
      for (const item of body.courses || []) {
        const code = item.code.trim().toUpperCase();
        let course = byCode.get(code);
        if (!course) {
          course = { id: nextId('courses'), code, name: item.name.trim(), credits: item.credits || 3, target_grade: item.target_grade ?? 70, course_note: null, grades: [] };
          state.courses.push(course);
          byCode.set(code, course);
          refreshCourse(course);
        } else {
          course.name = item.name.trim();
          if (item.credits != null) course.credits = item.credits;
          if (item.target_grade != null) course.target_grade = item.target_grade;
          refreshCourse(course);
        }
        for (const meeting of item.meetings || []) {
          nextSchedule.push({ id: nextId('meetings'), course_id: course.id, code: course.code, name: course.name, weekday: meeting.weekday, start_time: meeting.start_time, end_time: meeting.end_time, instructor: meeting.instructor || null, room: meeting.room || null, course_note: course.course_note });
          meetings += 1;
        }
      }
      state.schedule = nextSchedule;
      return commitMutation(previous, { updated_courses: (body.courses || []).length, updated_meetings: meetings }, { method, path: route, body });
    }

    if (method === 'PUT' && route === '/api/routine/goal') {
      const routine = refreshRoutine();
      routine.weekly_goal_minutes = body.weekly_goal_minutes;
      return commitMutation(previous, { weekly_goal_minutes: routine.weekly_goal_minutes }, { method, path: route, body });
    }
    if (method === 'POST' && route === '/api/routine/sessions') {
      if (body.course_id && !courseById(body.course_id)) throw makeError('Ders bulunamadı.', 404);
      const routine = refreshRoutine();
      const course = body.course_id ? courseById(body.course_id) : null;
      const alreadyStudiedToday = routine.sessions.some(item => item.date === localDate());
      const session = { id: nextId('sessions'), course_id: body.course_id || null, course_name: course?.name || null, date: localDate(), duration_minutes: body.duration_minutes, note: body.note?.trim() || null };
      routine.sessions.unshift(session);
      routine.week_by_day[session.date] = (routine.week_by_day[session.date] || 0) + session.duration_minutes;
      routine.week_minutes += session.duration_minutes;
      routine.today_minutes += session.duration_minutes;
      if (!alreadyStudiedToday) routine.streak_days += 1;
      refreshRoutine();
      return commitMutation(previous, { id: session.id, date: session.date }, { method, path: route, body, localType: 'sessions', localId: session.id });
    }
    if (method === 'POST' && route === '/api/routine/attendance') {
      const course = courseById(body.course_id);
      if (!course) throw makeError('Ders bulunamadı.', 404);
      if (body.session_date > localDate()) throw makeError('Gelecek tarihli yoklama kaydedilemez.', 422);
      const routine = refreshRoutine();
      let record = routine.attendance_records.find(item => item.course_id === course.id && item.date === body.session_date);
      const previousStatus = record?.status || null;
      if (!record) {
        record = { id: nextId('attendance'), course_id: course.id, course_code: course.code, course_name: course.name, date: body.session_date };
        routine.attendance_records.unshift(record);
      }
      Object.assign(record, { status: body.status, note: body.note?.trim() || null });
      const policy = routine.attendance_by_course.find(item => item.course_id === course.id);
      if (policy) {
        if (previousStatus && previousStatus !== body.status) policy[previousStatus] = Math.max(0, policy[previousStatus] - 1);
        if (previousStatus !== body.status) policy[body.status] = (policy[body.status] || 0) + 1;
        policy.total = policy.attended + policy.absent + policy.excused;
        policy.allowed_absences = body.allowed_absences;
        policy.risk = policy.allowed_absences ? policy.absent >= Math.max(1, policy.allowed_absences - 1) : policy.absent > 0;
      }
      refreshRoutine();
      return commitMutation(previous, { id: record.id, status: record.status, date: record.date }, { method, path: route, body, localType: record.id < 0 ? 'attendance' : null, localId: record.id < 0 ? record.id : null });
    }
    match = route.match(/^\/api\/routine\/attendance\/(\-?\d+)$/);
    if (method === 'DELETE' && match) {
      const routine = refreshRoutine();
      const recordIndex = routine.attendance_records.findIndex(item => item.id === Number(match[1]));
      if (recordIndex < 0) throw makeError('Yoklama kaydı bulunamadı.', 404);
      const deletedRecord = routine.attendance_records[recordIndex];
      const policy = routine.attendance_by_course.find(item => item.course_id === deletedRecord.course_id);
      if (policy && deletedRecord.status in policy) {
        policy[deletedRecord.status] = Math.max(0, policy[deletedRecord.status] - 1);
        policy.total = policy.attended + policy.absent + policy.excused;
        policy.risk = policy.allowed_absences ? policy.absent >= Math.max(1, policy.allowed_absences - 1) : policy.absent > 0;
      }
      routine.attendance_records.splice(recordIndex, 1);
      refreshRoutine();
      return commitMutation(previous, null, { method, path: route });
    }

    if (method === 'POST' && route === '/api/study/notes') {
      const note = { id: nextId('notes'), title: body.title.trim(), body: body.body.trim(), source_document_id: null, source_title: null, created_at: new Date().toISOString() };
      state.notes.unshift(note);
      return commitMutation(previous, note, { method, path: route, body, localType: 'notes', localId: note.id });
    }
    match = route.match(/^\/api\/study\/notes\/(\-?\d+)$/);
    if (method === 'DELETE' && match) {
      const noteIndex = state.notes.findIndex(note => note.id === Number(match[1]));
      if (noteIndex < 0) throw makeError('Not bulunamadı.', 404);
      state.notes.splice(noteIndex, 1);
      return commitMutation(previous, null, { method, path: route });
    }

    throw requiresInternet();
  }

  function remapPath(path, type, oldId, newId) {
    const patterns = {
      courses: /^(\/api\/courses\/)-?\d+(?=\/|$)/,
      tasks: /^(\/api\/tasks\/)-?\d+(?=\/|$)/,
      grades: /^(\/api\/courses\/-?\d+\/grades\/)-?\d+(?=\/|$)/,
      attendance: /^(\/api\/routine\/attendance\/)-?\d+(?=\/|$)/,
      notes: /^(\/api\/study\/notes\/)-?\d+(?=\/|$)/,
    };
    const pattern = patterns[type];
    if (!pattern) return path;
    const match = path.match(pattern);
    if (!match) return path;
    const segment = match[0].slice(match[1].length);
    if (Number(segment) !== Number(oldId)) return path;
    return path.replace(pattern, (_whole, prefix) => `${prefix}${newId}`);
  }

  function remapLocalId(type, oldId, newId) {
    if (type === 'courses') {
      for (const course of state.courses) if (course.id === oldId) course.id = newId;
      for (const course of state.courses) for (const grade of course.grades || []) if (grade.course_id === oldId) grade.course_id = newId;
      for (const task of state.tasks) if (task.course_id === oldId) task.course_id = newId;
      for (const entry of state.schedule) if (entry.course_id === oldId) entry.course_id = newId;
      for (const item of state.routine?.attendance_by_course || []) if (item.course_id === oldId) item.course_id = newId;
      for (const item of state.routine?.attendance_records || []) if (item.course_id === oldId) item.course_id = newId;
      for (const item of state.routine?.sessions || []) if (item.course_id === oldId) item.course_id = newId;
      for (const operation of state.pendingOps) {
        operation.path = remapPath(operation.path, 'courses', oldId, newId);
        if (operation.body?.course_id === oldId) operation.body.course_id = newId;
      }
    } else if (type === 'tasks') {
      for (const task of state.tasks) if (task.id === oldId) task.id = newId;
      for (const operation of state.pendingOps) operation.path = remapPath(operation.path, 'tasks', oldId, newId);
    } else if (type === 'grades') {
      for (const course of state.courses) {
        for (const grade of course.grades || []) if (grade.id === oldId) grade.id = newId;
        refreshCourse(course);
      }
      for (const operation of state.pendingOps) operation.path = remapPath(operation.path, 'grades', oldId, newId);
    } else if (type === 'attendance') {
      for (const item of state.routine?.attendance_records || []) if (item.id === oldId) item.id = newId;
      for (const operation of state.pendingOps) operation.path = remapPath(operation.path, 'attendance', oldId, newId);
    } else if (type === 'sessions') {
      for (const item of state.routine?.sessions || []) if (item.id === oldId) item.id = newId;
    } else if (type === 'notes') {
      for (const note of state.notes) if (note.id === oldId) note.id = newId;
      for (const operation of state.pendingOps) operation.path = remapPath(operation.path, 'notes', oldId, newId);
    }
  }

  async function syncPending(token) {
    if (!state || !token) throw makeError('Eşitlemek için internet bağlantısıyla tekrar giriş yap.');
    let synced = 0;
    while (state.pendingOps.length) {
      const operation = state.pendingOps[0];
      const headers = { Authorization: `Bearer ${token}` };
      const request = { method: operation.method, headers };
      if (operation.body !== null) {
        headers['Content-Type'] = 'application/json';
        request.body = JSON.stringify(operation.body);
      }
      let response;
      try { response = await fetch(operation.path, request); }
      catch { throw makeError('Eşitleme bağlantısı kesildi. Değişikliklerin bu cihazda korunuyor.'); }
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw makeError(data.detail || 'Bazı değişiklikler eşitlenemedi. Bu cihazdaki kayıtların korunuyor.', response.status);
      }
      const result = response.status === 204 ? null : await response.json().catch(() => null);
      if (operation.localType && result?.id != null) remapLocalId(operation.localType, operation.localId, result.id);
      if (operation.method === 'PUT' && operation.path === '/api/schedule') {
        const courseResponse = await fetch('/api/courses', { headers: { Authorization: `Bearer ${token}` } });
        if (!courseResponse.ok) {
          throw makeError('Program eşitlendi ancak ders kimlikleri alınamadı. Eşitlemeyi yeniden dene.', courseResponse.status);
        }
        const serverCourses = await courseResponse.json();
        const byCode = new Map(serverCourses.map(course => [String(course.code).toUpperCase(), course.id]));
        for (const course of state.courses) {
          const serverId = byCode.get(String(course.code).toUpperCase());
          if (serverId != null && course.id < 0) remapLocalId('courses', course.id, serverId);
        }
      }
      state.pendingOps.shift();
      await persist();
      synced += 1;
    }
    state.lastSyncedAt = new Date().toISOString();
    await persist();
    return { synced, pending: state.pendingOps.length };
  }

  window.CampusFlowOffline = {
    prepareOnline,
    unlockOffline,
    lock,
    async hasAccount(email) { return Boolean(await readAccount(email)); },
    get ready() { return Boolean(account && cryptoKey && state); },
    get pendingCount() { return state?.pendingOps?.length || 0; },
    get lastSyncedAt() { return state?.lastSyncedAt || null; },
    get user() { return state?.user ? copy(state.user) : null; },
    getSnapshot() { return state ? copy(state) : null; },
    setSnapshot,
    persist,
    api: localApi,
    syncPending,
  };

  function setSnapshot(snapshot) {
    updateSnapshot(snapshot);
  }
})();
