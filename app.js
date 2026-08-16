// =============================================
// EnviosApp - Firebase + Google Calendar
// =============================================
console.log('[EnviosApp] Cargando modulo...');
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js";
import { getAuth, signInWithPopup, signOut, onAuthStateChanged, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js";
import { getFirestore, initializeFirestore, enableIndexedDbPersistence, collection, doc, addDoc, updateDoc, deleteDoc, getDocs, getDoc, query, where, orderBy } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js";
console.log('[EnviosApp] SDK Firebase importado OK');
window._appModuleLoaded = true;

// --- Firebase Config ---
const firebaseConfig = {
  apiKey: "AIzaSyACjUN0s55UXqQ6w9G4ou5MI6L0hniK5Vo",
  authDomain: "traking-y-guias.firebaseapp.com",
  projectId: "traking-y-guias",
  storageBucket: "traking-y-guias.firebasestorage.app",
  messagingSenderId: "713350178616",
  appId: "1:713350178616:web:118aea490623cf93aa43cd"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const firestore = initializeFirestore(app, {
  experimentalForceLongPolling: true
}, 'gyatraking');

// Habilitar cache offline de Firestore en IndexedDB
enableIndexedDbPersistence(firestore).catch((err) => {
  if (err.code === 'failed-precondition') {
    console.warn('[EnviosApp] Persistencia offline no disponible: multiples pestanas abiertas');
  } else if (err.code === 'unimplemented') {
    console.warn('[EnviosApp] Persistencia offline no soportada en este navegador');
  }
});

let currentUser = null;
let googleAccessToken = null;
let filtroActual = 'todos';
let filtroLiqActual = 'todos';
let enviosCache = [];
let guiasCache = [];

// ===== AUTENTICACION =====
const provider = new GoogleAuthProvider();
provider.addScope('https://www.googleapis.com/auth/calendar.events');

document.getElementById('btnLogin').addEventListener('click', async () => {
  try {
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    googleAccessToken = credential.accessToken;
    localStorage.setItem('gAccessToken', googleAccessToken);
  } catch (error) {
    console.error('Error login:', error);
    mostrarToast('Error al iniciar sesion: ' + error.message);
  }
});

document.getElementById('btnLogout').addEventListener('click', async () => {
  if (confirm('Cerrar sesion?')) {
    await signOut(auth);
    localStorage.removeItem('gAccessToken');
  }
});

onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    googleAccessToken = localStorage.getItem('gAccessToken');
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('appMain').style.display = 'block';

    const avatar = document.getElementById('userAvatar');
    if (user.photoURL) {
      avatar.src = user.photoURL;
      avatar.style.display = 'block';
    }

    await cargarTodo();
  } else {
    currentUser = null;
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('appMain').style.display = 'none';
  }
});

// ===== INICIALIZACION UI =====
initNavegacion();
initFiltros();
initBusqueda();
setFechaDefault();
detectarOnline();

function initNavegacion() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const secId = btn.dataset.sec;
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
      document.getElementById(secId).classList.add('active');
      const fabContainer = document.getElementById('fabContainer');
      fabContainer.style.display = (secId === 'secEnvios' || secId === 'secDashboard') ? 'flex' : 'none';
      cerrarFab();
    });
  });
}

function initFiltros() {
  document.querySelectorAll('[data-filtro]').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('[data-filtro]').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      filtroActual = chip.dataset.filtro;
      renderEnvios();
    });
  });
  document.querySelectorAll('[data-filtro-liq]').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('[data-filtro-liq]').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      filtroLiqActual = chip.dataset.filtroLiq;
      renderLiquidacion();
    });
  });
}

function initBusqueda() {
  document.getElementById('buscarEnvio').addEventListener('input', (e) => {
    renderEnvios(e.target.value.toLowerCase());
  });
}

function setFechaDefault() {
  document.getElementById('envFecha').value = hoyStr();
}

// ===== UTILIDADES =====
function hoyStr() { return new Date().toISOString().split('T')[0]; }
function formatQ(monto) { return 'Q' + Number(monto || 0).toFixed(2); }
function esc(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function mostrarToast(msg) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

window.cerrarModal = function(id) { document.getElementById(id).style.display = 'none'; };

function estadoTexto(estado) {
  const map = { pendiente: 'Pendiente', en_camino: 'En camino', entregado: 'Entregado', fallido: 'Fallido' };
  return map[estado] || estado;
}

function detectarOnline() {
  const badge = document.getElementById('offlineBadge');
  const actualizar = () => { badge.style.display = navigator.onLine ? 'none' : 'inline'; };
  window.addEventListener('online', actualizar);
  window.addEventListener('offline', actualizar);
  actualizar();
}

// ===== FIRESTORE - CARGAR DATOS =====
async function cargarTodo() {
  let timeoutId;
  let cargaCompleta = false;

  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      if (!cargaCompleta) {
        console.warn('[EnviosApp] cargarTodo timeout - Firestore no respondio en 8s');
        mostrarToast('Firestore no responde. Usa "Test Firestore" para diagnosticar.');
      }
      resolve();
    }, 8000);
  });

  await Promise.race([
    Promise.all([cargarEnvios(), cargarGuias()]).then(() => { cargaCompleta = true; clearTimeout(timeoutId); }),
    timeout
  ]);

  renderDashboard();
  renderEnvios();
  renderGuias();
  renderLiquidacion();
}

async function cargarEnvios() {
  try {
    console.log('[EnviosApp] Cargando envios...');
    const q = query(collection(firestore, 'envios'), where('userId', '==', currentUser.uid));
    const snapshot = await getDocs(q);
    enviosCache = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    console.log('[EnviosApp] Envios cargados:', enviosCache.length);
  } catch (err) {
    console.error('Error cargando envios:', err);
    enviosCache = [];
  }
}

async function cargarGuias() {
  try {
    console.log('[EnviosApp] Cargando guias...');
    const q = query(collection(firestore, 'guias'), where('userId', '==', currentUser.uid));
    const snapshot = await getDocs(q);
    guiasCache = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    console.log('[EnviosApp] Guias cargadas:', guiasCache.length);
  } catch (err) {
    console.error('Error cargando guias:', err);
    guiasCache = [];
  }
}

// ===== MODAL ENVIO =====
window.abrirModalEnvio = async function(envioId = null) {
  const modal = document.getElementById('modalEnvio');
  const titulo = document.getElementById('modalEnvioTitulo');

  if (envioId) {
    const envio = enviosCache.find(e => e.id === envioId);
    if (!envio) return;
    titulo.textContent = 'Editar envio';
    document.getElementById('envioId').value = envio.id;
    document.getElementById('envioCalendarEventId').value = envio.calendarEventId || '';
    document.getElementById('envCliente').value = envio.cliente || '';
    document.getElementById('envTelefono').value = envio.telefono || '';
    document.getElementById('envDireccion').value = envio.direccion || '';
    document.getElementById('envTipo').value = envio.tipo || 'personal';
    document.getElementById('envEstado').value = envio.estado || 'pendiente';
    document.getElementById('envFecha').value = envio.fechaProgramada || '';
    document.getElementById('envHora').value = envio.horaProgramada || '';
    document.getElementById('envGuia').value = envio.numeroGuia || '';
    document.getElementById('envMontoCobrar').value = envio.montoCobrar || 0;
    document.getElementById('envMontoCobrado').value = envio.montoCobrado || 0;
    document.getElementById('envNotas').value = envio.notas || '';
    document.getElementById('envCrearCalendar').checked = false;
    if (envio.paqueteGuiaId) {
      document.getElementById('envPaqueteGuia').value = envio.paqueteGuiaId;
    }
  } else {
    titulo.textContent = 'Nuevo envio';
    document.getElementById('formEnvio').reset();
    document.getElementById('envioId').value = '';
    document.getElementById('envioCalendarEventId').value = '';
    setFechaDefault();
    document.getElementById('envMontoCobrar').value = 0;
    document.getElementById('envMontoCobrado').value = 0;
    document.getElementById('envCrearCalendar').checked = true;
  }

  cambiarTipoEnvio();
  cargarSelectGuias(envioId || null);

  // Re-asignar paquete despues de reconstruir el select
  if (envioId) {
    const envio = enviosCache.find(e => e.id === envioId);
    if (envio && envio.paqueteGuiaId) {
      document.getElementById('envPaqueteGuia').value = envio.paqueteGuiaId;
    }
  }

  modal.style.display = 'flex';
};

window.cambiarTipoEnvio = function() {
  const tipo = document.getElementById('envTipo').value;
  document.getElementById('grupoGuia').style.display = tipo === 'courier' ? 'block' : 'none';
  document.getElementById('grupoPaqueteGuia').style.display = tipo === 'courier' ? 'block' : 'none';
  // Calendar solo para entregas personales con hora
  document.getElementById('grupoCalendar').style.display = tipo === 'personal' ? 'block' : 'none';
};

function cargarSelectGuias(envioIdActual = null) {
  const select = document.getElementById('envPaqueteGuia');
  select.innerHTML = '<option value="">-- Sin asignar --</option>';
  guiasCache.forEach(p => {
    const enviosPaq = obtenerEnviosDePaquete(p.id);
    // No contar el envio que se esta editando
    const ocupados = envioIdActual ? enviosPaq.filter(e => e.id !== envioIdActual).length : enviosPaq.length;
    const disponibles = 10 - ocupados;
    if (disponibles > 0) {
      select.innerHTML += `<option value="${p.id}">#${esc(p.comprobante)} (${disponibles} espacios)</option>`;
    }
  });
}

// ===== GUARDAR ENVIO =====
window.guardarEnvio = async function(e) {
  e.preventDefault();

  const id = document.getElementById('envioId').value;
  const tipo = document.getElementById('envTipo').value;
  const paqueteGuiaId = document.getElementById('envPaqueteGuia').value;
  const crearCalendar = document.getElementById('envCrearCalendar').checked;
  const fecha = document.getElementById('envFecha').value;
  const hora = document.getElementById('envHora').value;

  const envio = {
    userId: currentUser.uid,
    cliente: document.getElementById('envCliente').value.trim(),
    telefono: document.getElementById('envTelefono').value.trim(),
    direccion: document.getElementById('envDireccion').value.trim(),
    tipo: tipo,
    estado: document.getElementById('envEstado').value,
    fechaProgramada: fecha,
    horaProgramada: hora,
    numeroGuia: tipo === 'courier' ? document.getElementById('envGuia').value.trim() : '',
    paqueteGuiaId: tipo === 'courier' && paqueteGuiaId ? paqueteGuiaId : null,
    montoCobrar: parseFloat(document.getElementById('envMontoCobrar').value) || 0,
    montoCobrado: parseFloat(document.getElementById('envMontoCobrado').value) || 0,
    notas: document.getElementById('envNotas').value.trim(),
    liquidada: false,
    updatedAt: new Date().toISOString()
  };

  try {
    if (id) {
      // Editar
      const anterior = enviosCache.find(e => e.id === id);
      envio.createdAt = anterior?.createdAt || new Date().toISOString();
      envio.calendarEventId = anterior?.calendarEventId || '';
      envio.liquidada = anterior?.liquidada || false;
      envio.fechaLiquidacion = anterior?.fechaLiquidacion || '';

      await updateDoc(doc(firestore, 'envios', id), envio);
      mostrarToast('Envio actualizado');
    } else {
      // Nuevo
      envio.createdAt = new Date().toISOString();
      envio.calendarEventId = '';
      envio.fechaLiquidacion = '';

      // Crear evento en Google Calendar si es personal con hora
      if (tipo === 'personal' && crearCalendar && hora && fecha) {
        const eventId = await crearEventoCalendar(envio);
        if (eventId) envio.calendarEventId = eventId;
      }

      await addDoc(collection(firestore, 'envios'), envio);
      mostrarToast('Envio creado');
    }

    cerrarModal('modalEnvio');
    await cargarTodo();
  } catch (err) {
    console.error('Error guardando envio:', err);
    mostrarToast('Error al guardar: ' + err.message);
  }
};


// ===== ELIMINAR ENVIO =====
window.eliminarEnvio = async function(id) {
  if (!confirm('Eliminar este envio?')) return;
  try {
    const envio = enviosCache.find(e => e.id === id);
    if (envio?.calendarEventId) await eliminarEventoCalendar(envio.calendarEventId);
    await deleteDoc(doc(firestore, 'envios', id));
    cerrarModal('modalDetalle');
    mostrarToast('Envio eliminado');
    await cargarTodo();
  } catch (err) {
    mostrarToast('Error al eliminar: ' + err.message);
  }
};

// ===== CAMBIAR ESTADO =====
window.cambiarEstado = async function(id, nuevoEstado) {
  try {
    const envio = enviosCache.find(e => e.id === id);
    if (!envio) return;
    const updates = { estado: nuevoEstado, updatedAt: new Date().toISOString() };
    if (nuevoEstado === 'entregado' && envio.montoCobrar > 0 && (envio.montoCobrado || 0) === 0) {
      updates.montoCobrado = envio.montoCobrar;
    }
    await updateDoc(doc(firestore, 'envios', id), updates);
    cerrarModal('modalDetalle');
    mostrarToast('Estado actualizado');
    await cargarTodo();
  } catch (err) {
    mostrarToast('Error: ' + err.message);
  }
};

// ===== EDITAR ENVIO =====
window.editarEnvio = function(id) {
  cerrarModal('modalDetalle');
  abrirModalEnvio(id);
};

// ===== GOOGLE CALENDAR =====
async function obtenerTokenFresco() {
  // Verificar si el token guardado sigue siendo valido
  if (googleAccessToken) {
    try {
      const test = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1', {
        headers: { 'Authorization': `Bearer ${googleAccessToken}` }
      });
      if (test.ok) return googleAccessToken;
      // Token expirado, limpiar
      googleAccessToken = null;
      localStorage.removeItem('gAccessToken');
    } catch {
      // Sin conexion u otro error, intentar con el token actual
      return googleAccessToken;
    }
  }

  // No hay token valido, pedir al usuario que re-autorice
  if (!confirm('Se necesita acceso a Google Calendar. Se abrira una ventana para autorizar. ¿Continuar?')) {
    return null;
  }

  try {
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    googleAccessToken = credential.accessToken;
    localStorage.setItem('gAccessToken', googleAccessToken);
    return googleAccessToken;
  } catch (err) {
    console.error('Error obteniendo token:', err);
    mostrarToast('No se pudo autorizar. Intenta cerrar sesion y volver a entrar.');
    return null;
  }
}

async function crearEventoCalendar(envio) {
  if (!navigator.onLine) {
    mostrarToast('Sin conexion: el recordatorio de Calendar se omitio');
    return null;
  }
  const token = await obtenerTokenFresco();
  if (!token) {
    mostrarToast('No se pudo conectar con Google Calendar');
    return null;
  }

  const fechaHora = `${envio.fechaProgramada}T${envio.horaProgramada}:00`;
  const inicio = new Date(fechaHora);
  const fin = new Date(inicio.getTime() + 30 * 60 * 1000); // 30 min duracion

  const evento = {
    summary: `Entrega: ${envio.cliente}`,
    description: `Direccion: ${envio.direccion}\nTelefono: ${envio.telefono || 'N/A'}\nMonto a cobrar: ${formatQ(envio.montoCobrar)}${envio.notas ? '\nNotas: ' + envio.notas : ''}`,
    start: {
      dateTime: inicio.toISOString(),
      timeZone: 'America/Guatemala'
    },
    end: {
      dateTime: fin.toISOString(),
      timeZone: 'America/Guatemala'
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 15 },
        { method: 'popup', minutes: 5 }
      ]
    }
  };

  try {
    const response = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(evento)
    });

    if (response.status === 401) {
      // Token expirado, reintentar
      localStorage.removeItem('gAccessToken');
      googleAccessToken = null;
      const newToken = await obtenerTokenFresco();
      if (!newToken) return null;

      const retry = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${newToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(evento)
      });
      if (retry.ok) {
        const data = await retry.json();
        mostrarToast('Recordatorio creado en Google Calendar');
        return data.id;
      }
    } else if (response.ok) {
      const data = await response.json();
      mostrarToast('Recordatorio creado en Google Calendar');
      return data.id;
    }
  } catch (err) {
    console.error('Error Calendar:', err);
    mostrarToast('No se pudo crear el evento en Calendar');
  }
  return null;
}

async function eliminarEventoCalendar(eventId) {
  const token = await obtenerTokenFresco();
  if (!token || !eventId) return;
  try {
    await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
  } catch (err) {
    console.error('Error eliminando evento Calendar:', err);
  }
}

// ===== RENDER DASHBOARD =====
function renderDashboard() {
  const hoy = hoyStr();
  const pendientes = enviosCache.filter(e => e.estado === 'pendiente');
  const enCamino = enviosCache.filter(e => e.estado === 'en_camino');
  const entregadosHoy = enviosCache.filter(e => e.estado === 'entregado' && e.fechaProgramada === hoy);

  let dineroPendiente = 0;
  enviosCache.forEach(e => {
    if (e.tipo === 'courier' && e.estado === 'entregado' && !e.liquidada && e.montoCobrar > 0) {
      dineroPendiente += calcularNeto(e.montoCobrar);
    }
  });

  document.getElementById('statPendientes').textContent = pendientes.length;
  document.getElementById('statEnCamino').textContent = enCamino.length;
  document.getElementById('statEntregados').textContent = entregadosHoy.length;
  document.getElementById('statDineroPendiente').textContent = formatQ(dineroPendiente);

  // Proximas entregas
  const manana = new Date();
  manana.setDate(manana.getDate() + 1);
  const mananaStr = manana.toISOString().split('T')[0];

  const proximas = enviosCache
    .filter(e => (e.estado === 'pendiente' || e.estado === 'en_camino') &&
                 (e.fechaProgramada === hoy || e.fechaProgramada === mananaStr))
    .sort((a, b) => {
      const da = (a.fechaProgramada || '') + (a.horaProgramada || '99:99');
      const db2 = (b.fechaProgramada || '') + (b.horaProgramada || '99:99');
      return da.localeCompare(db2);
    })
    .slice(0, 5);

  const contenedor = document.getElementById('proximasEntregas');
  if (proximas.length === 0) {
    contenedor.innerHTML = '<div class="empty-state"><p>No hay entregas proximas</p></div>';
  } else {
    contenedor.innerHTML = proximas.map(e => `
      <div class="envio-item" onclick="verDetalle('${e.id}')">
        <div class="envio-top">
          <span class="envio-cliente">${esc(e.cliente)}</span>
          <span class="badge badge-${e.tipo}">${e.tipo}</span>
        </div>
        <div class="envio-meta">
          <span>${e.fechaProgramada === hoy ? 'Hoy' : 'Manana'} ${e.horaProgramada || ''}</span>
          <span>${e.montoCobrar > 0 ? formatQ(e.montoCobrar) : ''}</span>
        </div>
      </div>
    `).join('');
  }

  // Alarmas
  renderAlarmas();

  // Alerta de envios sin paquete
  const sinPaquete = obtenerEnviosSinPaquete();
  const alertaGuias = document.getElementById('guiasAlerta');
  if (sinPaquete.length > 0) {
    alertaGuias.innerHTML = `
      <div class="alarma-item urgente">
        <div class="alarma-titulo">${sinPaquete.length} envio(s) sin paquete asignado</div>
        <div class="alarma-detalle">Registra un paquete para asignarlos</div>
      </div>
    `;
  } else {
    alertaGuias.innerHTML = '';
  }
}

function renderAlarmas() {
  const ahora = new Date();
  const alarmas = [];

  enviosCache.forEach(e => {
    // Envio retrasado
    if ((e.estado === 'pendiente' || e.estado === 'en_camino') && e.fechaProgramada) {
      const fechaEnvio = new Date(e.fechaProgramada + 'T23:59:59');
      if (fechaEnvio < ahora) {
        alarmas.push({
          tipo: 'urgente',
          titulo: `Envio retrasado: ${e.cliente}`,
          detalle: `Programado: ${e.fechaProgramada}`,
          id: e.id
        });
      }
    }

    // Entrega personal proxima (dentro de 1 hora)
    if (e.tipo === 'personal' && (e.estado === 'pendiente' || e.estado === 'en_camino')
        && e.fechaProgramada && e.horaProgramada) {
      const fechaEntrega = new Date(`${e.fechaProgramada}T${e.horaProgramada}`);
      const diffMin = (fechaEntrega - ahora) / 60000;
      if (diffMin > 0 && diffMin <= 60) {
        alarmas.push({
          tipo: 'normal',
          titulo: `Entrega pronto: ${e.cliente}`,
          detalle: `Hoy a las ${e.horaProgramada} (en ${Math.round(diffMin)} min)`,
          id: e.id
        });
      }
    }

    // Dinero sin liquidar (courier no ha transferido)
    if (e.tipo === 'courier' && e.estado === 'entregado' && !e.liquidada && e.montoCobrar > 0) {
      alarmas.push({
        tipo: 'urgente',
        titulo: `Sin liquidar: ${e.cliente}`,
        detalle: `Neto pendiente: ${formatQ(calcularNeto(e.montoCobrar))}`,
        id: e.id
      });
    }
  });

  const contenedor = document.getElementById('alarmasActivas');
  if (alarmas.length === 0) {
    contenedor.innerHTML = '<div class="empty-state"><p>Sin alarmas activas</p></div>';
  } else {
    contenedor.innerHTML = alarmas.map(a => `
      <div class="alarma-item ${a.tipo === 'urgente' ? 'urgente' : ''}" onclick="verDetalle('${a.id}')">
        <div class="alarma-titulo">${esc(a.titulo)}</div>
        <div class="alarma-detalle">${esc(a.detalle)}</div>
      </div>
    `).join('');
  }
}

// ===== RENDER ENVIOS =====
function renderEnvios(busqueda = '') {
  let envios = [...enviosCache];

  if (filtroActual !== 'todos') {
    envios = envios.filter(e => e.estado === filtroActual);
  }

  if (busqueda) {
    envios = envios.filter(e =>
      (e.cliente || '').toLowerCase().includes(busqueda) ||
      (e.direccion || '').toLowerCase().includes(busqueda) ||
      (e.numeroGuia || '').toLowerCase().includes(busqueda)
    );
  }

  envios.sort((a, b) => {
    const orden = { pendiente: 0, en_camino: 1, entregado: 2, fallido: 3 };
    if (orden[a.estado] !== orden[b.estado]) return orden[a.estado] - orden[b.estado];
    return (b.fechaProgramada || '').localeCompare(a.fechaProgramada || '');
  });

  const contenedor = document.getElementById('listaEnvios');
  if (envios.length === 0) {
    contenedor.innerHTML = '<div class="empty-state"><p>No hay envios</p></div>';
    return;
  }

  contenedor.innerHTML = envios.map(e => `
    <div class="envio-item" onclick="verDetalle('${e.id}')">
      <div class="envio-top">
        <span class="envio-cliente">${esc(e.cliente)}</span>
        <span class="envio-monto">${e.montoCobrar > 0 ? formatQ(e.montoCobrar) : ''}</span>
      </div>
      <div class="envio-meta">
        <span class="badge badge-${e.estado}">${estadoTexto(e.estado)}</span>
        <span class="badge badge-${e.tipo}">${e.tipo}</span>
        <span>${e.fechaProgramada || ''} ${e.horaProgramada || ''}</span>
        ${e.numeroGuia ? `<span>Guia: ${esc(e.numeroGuia)}</span>` : ''}
      </div>
    </div>
  `).join('');
}

// ===== VER DETALLE =====
window.verDetalle = function(id) {
  const envio = enviosCache.find(e => e.id === id);
  if (!envio) return;

  const contenido = document.getElementById('detalleContenido');
  contenido.innerHTML = `
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <span class="badge badge-${envio.estado}">${estadoTexto(envio.estado)}</span>
        <span class="badge badge-${envio.tipo}">${envio.tipo}</span>
      </div>
      <p><strong>Cliente:</strong> ${esc(envio.cliente)}</p>
      ${envio.telefono ? `<p><strong>Telefono:</strong> <a href="tel:${envio.telefono}">${esc(envio.telefono)}</a></p>` : ''}
      <p><strong>Direccion:</strong> ${esc(envio.direccion)}</p>
      <p><strong>Fecha:</strong> ${envio.fechaProgramada || 'Sin fecha'} ${envio.horaProgramada || ''}</p>
      ${envio.numeroGuia ? `<p><strong>Guia:</strong> ${esc(envio.numeroGuia)}</p>` : ''}
      ${envio.montoCobrar > 0 ? `<p><strong>Cobrar:</strong> ${formatQ(envio.montoCobrar)}</p>` : ''}
      ${envio.notas ? `<p><strong>Notas:</strong> ${esc(envio.notas)}</p>` : ''}
      ${envio.calendarEventId ? '<p style="font-size:12px;color:var(--success);">Tiene recordatorio en Google Calendar</p>' : ''}
      ${envio.tipo === 'courier' && envio.estado === 'entregado' && envio.montoCobrar > 0 ? `
        <div style="margin-top:10px; padding:10px; background:var(--gray-50); border-radius:6px; font-size:13px;">
          <p><strong>Liquidacion:</strong></p>
          <p>Bruto cobrado: ${formatQ(envio.montoCobrar)}</p>
          <p>Comision (3.8%): -${formatQ(envio.montoCobrar * COMISION_PORCENTAJE)}</p>
          <p>Fee transferencia: -${formatQ(FEE_TRANSFERENCIA)}</p>
          <p style="font-weight:700;">Neto: ${formatQ(calcularNeto(envio.montoCobrar))}</p>
          <p style="margin-top:6px;">${envio.liquidada
            ? '<span style="color:var(--success); font-weight:600;">Liquidada</span> - ' + (envio.fechaLiquidacion ? new Date(envio.fechaLiquidacion).toLocaleDateString() : '')
            : '<span style="color:var(--warning); font-weight:600;">Pendiente de liquidar</span>'
          }</p>
        </div>
      ` : ''}
      <p style="font-size:11px;color:var(--gray-500);margin-top:8px;">Creado: ${envio.createdAt ? new Date(envio.createdAt).toLocaleString() : ''}</p>
    </div>
    <div class="acciones-envio">
      ${envio.estado === 'pendiente' ? `<button class="btn btn-sm btn-primary" onclick="cambiarEstado('${envio.id}','en_camino')">En camino</button>` : ''}
      ${envio.estado === 'en_camino' ? `<button class="btn btn-sm btn-success" onclick="cambiarEstado('${envio.id}','entregado')">Entregado</button>` : ''}
      ${envio.estado !== 'fallido' && envio.estado !== 'entregado' ? `<button class="btn btn-sm btn-danger" onclick="cambiarEstado('${envio.id}','fallido')">Fallido</button>` : ''}
      ${envio.estado === 'fallido' ? `<button class="btn btn-sm btn-primary" onclick="cambiarEstado('${envio.id}','pendiente')">Reprogramar</button>` : ''}
      ${envio.tipo === 'courier' && envio.estado === 'entregado' && !envio.liquidada && envio.montoCobrar > 0 ? `<button class="btn btn-sm btn-success" onclick="marcarLiquidada('${envio.id}')">Marcar liquidada</button>` : ''}
      <button class="btn btn-sm btn-outline" onclick="editarEnvio('${envio.id}')">Editar</button>
      <button class="btn btn-sm btn-danger" onclick="eliminarEnvio('${envio.id}')">Eliminar</button>
    </div>
  `;
  document.getElementById('modalDetalle').style.display = 'flex';
};

// ===== PAQUETES DE GUIAS =====

function obtenerEnviosSinPaquete() {
  return enviosCache.filter(e => e.tipo === 'courier' && !e.paqueteGuiaId);
}

function obtenerEnviosDePaquete(paqueteId) {
  return enviosCache.filter(e => e.paqueteGuiaId === paqueteId);
}

window.abrirModalGuia = function() {
  document.getElementById('modalGuiaTitulo').textContent = 'Registrar paquete';
  document.getElementById('guiaComprobante').value = '';
  document.getElementById('guiaCosto').value = '';
  document.getElementById('guiaFechaPago').value = hoyStr();
  document.getElementById('guiaNotas').value = '';

  // Mostrar envios sin asignar
  const sinAsignar = obtenerEnviosSinPaquete();
  const container = document.getElementById('enviosSinAsignarContainer');
  const lista = document.getElementById('enviosSinAsignarLista');

  if (sinAsignar.length > 0) {
    container.style.display = 'block';
    lista.innerHTML = sinAsignar.map(e => `
      <label class="checkbox-item">
        <input type="checkbox" class="chk-asignar" value="${e.id}" checked>
        <span>${esc(e.cliente)} - ${formatQ(e.montoCobrar)} (${e.fechaProgramada})</span>
      </label>
    `).join('');
  } else {
    container.style.display = 'none';
  }

  document.getElementById('modalGuia').style.display = 'flex';
};

window.guardarPaquete = async function() {
  const comprobante = document.getElementById('guiaComprobante').value.trim();
  if (!comprobante) { mostrarToast('Ingresa el numero de comprobante'); return; }

  const paquete = {
    userId: currentUser.uid,
    comprobante: comprobante,
    capacidad: 10,
    costo: parseFloat(document.getElementById('guiaCosto').value) || 0,
    fechaPago: document.getElementById('guiaFechaPago').value,
    notas: document.getElementById('guiaNotas').value.trim(),
    createdAt: new Date().toISOString()
  };

  // Cerrar modal inmediatamente
  cerrarModal('modalGuia');
  mostrarToast('Guardando paquete...');

  addDoc(collection(firestore, 'guias'), paquete).then(async (docRef) => {
    const paqueteId = docRef.id;

    // Asignar envios seleccionados a este paquete
    const checkboxes = document.querySelectorAll('.chk-asignar:checked');
    let asignados = 0;
    for (const chk of checkboxes) {
      if (asignados >= 10) break;
      try {
        await updateDoc(doc(firestore, 'envios', chk.value), { paqueteGuiaId: paqueteId });
        asignados++;
      } catch (assignErr) {
        console.error('Error asignando envio:', assignErr);
      }
    }

    mostrarToast(`Paquete #${comprobante} registrado (${asignados} envios asignados)`);
    await cargarTodo();
  }).catch((err) => {
    console.error('Error guardando paquete:', err);
    alert('Error guardando paquete: ' + err.code + ' - ' + err.message);
  });
};

window.verDetallePaquete = function(paqueteId) {
  const paquete = guiasCache.find(g => g.id === paqueteId);
  if (!paquete) return;

  const enviosPaquete = obtenerEnviosDePaquete(paqueteId);
  const disponibles = 10 - enviosPaquete.length;

  const contenido = document.getElementById('detallePaqueteContenido');
  contenido.innerHTML = `
    <div class="card">
      <p><strong>Comprobante:</strong> ${esc(paquete.comprobante)}</p>
      <p><strong>Fecha pago:</strong> ${paquete.fechaPago || 'Sin fecha'}</p>
      <p><strong>Costo:</strong> ${formatQ(paquete.costo)}</p>
      <p><strong>Ocupacion:</strong> ${enviosPaquete.length}/10</p>
      ${paquete.notas ? `<p><strong>Notas:</strong> ${esc(paquete.notas)}</p>` : ''}
    </div>

    <h3 style="font-size:14px; margin:12px 0 8px;">Envios asignados (${enviosPaquete.length}/10)</h3>
    ${enviosPaquete.length > 0 ? enviosPaquete.map((e, i) => `
      <div class="envio-item" onclick="verDetalle('${e.id}')">
        <div class="envio-top">
          <span class="envio-cliente">${i + 1}. ${esc(e.cliente)}</span>
          <span class="envio-monto">${formatQ(e.montoCobrar)}</span>
        </div>
        <div class="envio-meta">
          <span class="badge badge-${e.estado}">${estadoTexto(e.estado)}</span>
          <span>${e.fechaProgramada}</span>
        </div>
      </div>
    `).join('') : '<p style="color:var(--gray-500); font-size:13px;">Ningun envio asignado</p>'}

    ${disponibles > 0 ? `
      <button class="btn btn-sm btn-primary" onclick="asignarEnviosAPaquete('${paqueteId}')" style="margin-top:12px;">
        Asignar envios sin paquete (${disponibles} espacios libres)
      </button>
    ` : ''}

    <div style="display:flex; gap:8px; margin-top:16px;">
      <button class="btn btn-sm btn-danger" onclick="eliminarPaquete('${paqueteId}')">Eliminar paquete</button>
    </div>
  `;

  document.getElementById('modalDetallePaquete').style.display = 'flex';
};

window.asignarEnviosAPaquete = async function(paqueteId) {
  const enviosPaquete = obtenerEnviosDePaquete(paqueteId);
  const disponibles = 10 - enviosPaquete.length;
  const sinAsignar = obtenerEnviosSinPaquete();

  if (sinAsignar.length === 0) {
    mostrarToast('No hay envios sin asignar');
    return;
  }

  // Asignar automaticamente los mas antiguos
  const porAsignar = sinAsignar.slice(0, disponibles);
  try {
    for (const envio of porAsignar) {
      await updateDoc(doc(firestore, 'envios', envio.id), { paqueteGuiaId: paqueteId });
    }
    mostrarToast(`${porAsignar.length} envio(s) asignados`);
    cerrarModal('modalDetallePaquete');
    await cargarTodo();
  } catch (err) {
    mostrarToast('Error: ' + err.message);
  }
};

window.eliminarPaquete = async function(id) {
  if (!confirm('Eliminar este paquete? Los envios quedaran sin asignar.')) return;
  try {
    // Desasignar envios de este paquete
    const enviosPaquete = obtenerEnviosDePaquete(id);
    for (const envio of enviosPaquete) {
      await updateDoc(doc(firestore, 'envios', envio.id), { paqueteGuiaId: null });
    }
    await deleteDoc(doc(firestore, 'guias', id));
    cerrarModal('modalDetallePaquete');
    mostrarToast('Paquete eliminado');
    await cargarTodo();
  } catch (err) {
    mostrarToast('Error: ' + err.message);
  }
};

function renderGuias() {
  const contenedor = document.getElementById('listaGuias');
  const sinAsignar = obtenerEnviosSinPaquete();

  // Alerta de envios sin asignar
  const alerta = document.getElementById('alertaSinAsignar');
  const alertaTexto = document.getElementById('alertaSinAsignarTexto');
  if (sinAsignar.length > 0) {
    alerta.style.display = 'block';
    alertaTexto.textContent = `${sinAsignar.length} envio(s) sin paquete asignado`;
  } else {
    alerta.style.display = 'none';
  }

  if (guiasCache.length === 0) {
    contenedor.innerHTML = '<div class="empty-state"><p>No hay paquetes registrados</p></div>';
    return;
  }

  contenedor.innerHTML = guiasCache.map(p => {
    const enviosPaq = obtenerEnviosDePaquete(p.id);
    const ocupados = enviosPaq.length;
    const porcentaje = (ocupados / 10) * 100;
    let barClass = '';
    if (porcentaje >= 100) barClass = ''; // lleno = azul
    else if (porcentaje >= 50) barClass = 'medium';
    else barClass = 'low';

    return `
      <div class="guia-item" onclick="verDetallePaquete('${p.id}')" style="cursor:pointer">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div>
            <strong>#${esc(p.comprobante)}</strong>
            <br><span style="font-size:12px;color:var(--gray-500)">${p.fechaPago || 'Sin fecha'}</span>
          </div>
          <div style="text-align:right">
            <span style="font-size:14px; font-weight:600;">${ocupados}/10</span>
            ${p.costo ? `<br><span style="font-size:11px;color:var(--gray-500)">${formatQ(p.costo)}</span>` : ''}
          </div>
        </div>
        <div class="guia-stock">
          <div class="guia-bar">
            <div class="guia-bar-fill ${barClass}" style="width:${porcentaje}%"></div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// ===== LIQUIDACION =====
const COMISION_PORCENTAJE = 0.038; // 3.8%
const FEE_TRANSFERENCIA = 1; // Q1 por envio

function calcularNeto(monto) {
  const comision = monto * COMISION_PORCENTAJE;
  return monto - comision - FEE_TRANSFERENCIA;
}

function renderLiquidacion() {
  // Solo envios courier con monto > 0
  const courierConMonto = enviosCache.filter(e => e.tipo === 'courier' && e.montoCobrar > 0);

  let totalBrutoEntregado = 0;
  let totalComisiones = 0;
  let totalFees = 0;
  let totalNetoRecibido = 0;
  let totalPorLiquidar = 0;
  const items = [];

  courierConMonto.forEach(e => {
    if (e.estado === 'entregado' && e.liquidada) {
      // Liquidada: ya te pagaron
      const comision = e.montoCobrar * COMISION_PORCENTAJE;
      const neto = e.montoCobrar - comision - FEE_TRANSFERENCIA;
      totalBrutoEntregado += e.montoCobrar;
      totalComisiones += comision;
      totalFees += FEE_TRANSFERENCIA;
      totalNetoRecibido += neto;
      items.push({ ...e, liqEstado: 'liquidada', neto });
    } else if (e.estado === 'entregado' && !e.liquidada) {
      // Entregada pero no liquidada: courier tiene tu dinero
      const comision = e.montoCobrar * COMISION_PORCENTAJE;
      const neto = e.montoCobrar - comision - FEE_TRANSFERENCIA;
      totalPorLiquidar += neto;
      items.push({ ...e, liqEstado: 'entregada', neto });
    } else if (e.estado === 'fallido') {
      // No se liquida
    } else {
      // Pendiente o en camino
      items.push({ ...e, liqEstado: 'pendiente', neto: 0 });
    }
  });

  document.getElementById('liqRecibido').textContent = formatQ(totalNetoRecibido);
  document.getElementById('liqPorLiquidar').textContent = formatQ(totalPorLiquidar);
  document.getElementById('liqComisiones').textContent = formatQ(totalComisiones + totalFees);

  // Desglose
  document.getElementById('liqDesglose').innerHTML = `
    <p><strong>Desglose total (liquidadas):</strong></p>
    <p>Cobrado bruto: ${formatQ(totalBrutoEntregado)}</p>
    <p>Comision courier (3.8%): -${formatQ(totalComisiones)}</p>
    <p>Fee transferencias (Q1 c/u): -${formatQ(totalFees)}</p>
    <p style="font-weight:700; margin-top:4px;">Neto recibido: ${formatQ(totalNetoRecibido)}</p>
    ${totalPorLiquidar > 0 ? `<p style="color:var(--warning); margin-top:6px; font-weight:600;">Pendiente de liquidar: ${formatQ(totalPorLiquidar)}</p>` : ''}
  `;

  // Filtrar
  let filtrados = items;
  if (filtroLiqActual !== 'todos') {
    filtrados = items.filter(i => i.liqEstado === filtroLiqActual);
  }

  const contenedor = document.getElementById('listaLiquidacion');
  if (filtrados.length === 0) {
    contenedor.innerHTML = '<div class="empty-state"><p>No hay movimientos</p></div>';
    return;
  }

  contenedor.innerHTML = filtrados.map(e => {
    let badgeClass = '', badgeText = '';
    if (e.liqEstado === 'liquidada') { badgeClass = 'badge-entregado'; badgeText = 'Liquidada'; }
    else if (e.liqEstado === 'entregada') { badgeClass = 'badge-pendiente'; badgeText = 'Sin liquidar'; }
    else { badgeClass = 'badge-en_camino'; badgeText = estadoTexto(e.estado); }

    return `
      <div class="envio-item" onclick="verDetalle('${e.id}')">
        <div class="envio-top">
          <span class="envio-cliente">${esc(e.cliente)}</span>
          <span class="badge ${badgeClass}">${badgeText}</span>
        </div>
        <div class="envio-meta">
          <span>Cobrar: ${formatQ(e.montoCobrar)}</span>
          ${e.liqEstado !== 'pendiente' ? `<span>Neto: ${formatQ(e.neto)}</span>` : ''}
          <span>${e.fechaProgramada || ''}</span>
        </div>
      </div>
    `;
  }).join('');
}

// Marcar como liquidada
window.marcarLiquidada = async function(id) {
  try {
    await updateDoc(doc(firestore, 'envios', id), {
      liquidada: true,
      fechaLiquidacion: new Date().toISOString()
    });
    cerrarModal('modalDetalle');
    mostrarToast('Marcada como liquidada');
    await cargarTodo();
  } catch (err) {
    mostrarToast('Error: ' + err.message);
  }
};

// Marcar varias como liquidadas
window.liquidarTodas = async function() {
  const porLiquidar = enviosCache.filter(e =>
    e.tipo === 'courier' && e.estado === 'entregado' && !e.liquidada && e.montoCobrar > 0
  );
  if (porLiquidar.length === 0) { mostrarToast('No hay envios por liquidar'); return; }
  if (!confirm(`Marcar ${porLiquidar.length} envio(s) como liquidados?`)) return;

  try {
    for (const envio of porLiquidar) {
      await updateDoc(doc(firestore, 'envios', envio.id), {
        liquidada: true,
        fechaLiquidacion: new Date().toISOString()
      });
    }
    mostrarToast(`${porLiquidar.length} envio(s) liquidados`);
    await cargarTodo();
  } catch (err) {
    mostrarToast('Error: ' + err.message);
  }
};

// ===== FAB (boton flotante) =====
window.toggleFab = function() {
  const options = document.getElementById('fabOptions');
  const fab = document.getElementById('fabAgregar');
  if (options.style.display === 'none') {
    options.style.display = 'flex';
    fab.classList.add('open');
  } else {
    cerrarFab();
  }
};

window.cerrarFab = function() {
  document.getElementById('fabOptions').style.display = 'none';
  document.getElementById('fabAgregar').classList.remove('open');
};

// ===== GUIA RAPIDA =====
window.abrirModalGuiaRapida = function() {
  document.getElementById('formGuiaRapida').reset();
  document.getElementById('grPreview').style.display = 'none';

  // Cargar paquetes con espacio disponible
  const select = document.getElementById('grPaqueteGuia');
  select.innerHTML = '<option value="">-- Sin asignar (pago despues) --</option>';
  guiasCache.forEach(p => {
    const ocupados = obtenerEnviosDePaquete(p.id).length;
    const disponibles = 10 - ocupados;
    if (disponibles > 0) {
      select.innerHTML += `<option value="${p.id}">#${esc(p.comprobante)} (${disponibles} espacios)</option>`;
    }
  });

  document.getElementById('modalGuiaRapida').style.display = 'flex';
};

function generarTextoGR() {
  const nombre = document.getElementById('grNombre').value.trim();
  const telefono = document.getElementById('grTelefono').value.trim();
  const direccion = document.getElementById('grDireccion').value.trim();
  const monto = parseFloat(document.getElementById('grMonto').value) || 0;

  return `Nombre: ${nombre}\nTeléfono: ${telefono}\nDirección: ${direccion}\nTotal a cobrar ${monto.toFixed(2)}`;
}

window.generarPreviewGR = function() {
  const nombre = document.getElementById('grNombre').value.trim();
  if (!nombre) { mostrarToast('Ingresa al menos el nombre'); return; }

  const texto = generarTextoGR();
  document.getElementById('grTexto').textContent = texto;
  document.getElementById('grPreview').style.display = 'block';
};

window.copiarGuiaRapida = async function() {
  const texto = generarTextoGR();
  try {
    await navigator.clipboard.writeText(texto);
    mostrarToast('Texto copiado al portapapeles');
  } catch {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = texto;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    mostrarToast('Texto copiado');
  }
};

window.guardarGuiaRapida = async function(e) {
  if (e) e.preventDefault();
  const nombre = document.getElementById('grNombre').value.trim();
  const telefono = document.getElementById('grTelefono').value.trim();
  const direccion = document.getElementById('grDireccion').value.trim();
  const monto = parseFloat(document.getElementById('grMonto').value) || 0;
  const paqueteGuiaId = document.getElementById('grPaqueteGuia').value;

  if (!nombre) { mostrarToast('Ingresa el nombre'); return; }

  const envio = {
    userId: currentUser.uid,
    cliente: nombre,
    telefono: telefono,
    direccion: direccion,
    tipo: 'courier',
    estado: 'pendiente',
    fechaProgramada: hoyStr(),
    horaProgramada: '',
    numeroGuia: '',
    paqueteGuiaId: paqueteGuiaId || null,
    montoCobrar: monto,
    montoCobrado: 0,
    liquidada: false,
    notas: '',
    calendarEventId: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  // Copiar texto primero (no depende de Firebase)
  const texto = generarTextoGR();
  try {
    await navigator.clipboard.writeText(texto);
  } catch (clipErr) {
    const ta = document.createElement('textarea');
    ta.value = texto;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }

  // Guardar en Firebase y cerrar
  cerrarModal('modalGuiaRapida');
  mostrarToast('Texto copiado. Guardando...');

  addDoc(collection(firestore, 'envios'), envio).then(async () => {
    mostrarToast('Guia rapida creada');
    await cargarTodo();
  }).catch((err) => {
    console.error('Error Firebase:', err);
    mostrarToast('Error al guardar: ' + err.message);
  });
};

// ===== TEST FIRESTORE =====
window.testFirestore = async function() {
  if (!currentUser) { alert('No hay usuario logueado'); return; }

  mostrarToast('Ejecutando diagnostico...');
  const resultados = [];

  // 1. Verificar que Firebase Auth funciona
  resultados.push('1. Auth: OK (usuario: ' + currentUser.email + ')');

  // 2. Intentar escribir con el SDK (con timeout)
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('TIMEOUT_10s')), 10000)
  );

  try {
    const testDoc = { userId: currentUser.uid, test: true, timestamp: new Date().toISOString() };
    const ref = await Promise.race([
      addDoc(collection(firestore, 'test'), testDoc),
      timeout
    ]);
    await deleteDoc(doc(firestore, 'test', ref.id));
    resultados.push('2. SDK Firestore: OK - escritura y borrado exitoso!');
  } catch (err) {
    if (err.message === 'TIMEOUT_10s') {
      resultados.push('2. SDK Firestore: TIMEOUT (no respondio en 10s)\n   -> La base de datos no responde.\n   -> Verifica en Firebase Console que tengas\n      "Firestore Database" (NO "Realtime Database").\n   -> Debe estar en modo NATIVE, no Datastore.');
    } else {
      resultados.push('2. SDK Firestore: ERROR\n   Codigo: ' + (err.code || 'sin codigo') + '\n   Mensaje: ' + err.message);
    }
  }

  alert('DIAGNOSTICO FIRESTORE:\n\n' + resultados.join('\n\n'));
  console.log('Diagnostico:', resultados);
};

// ===== DATOS DE PRUEBA (temporal) =====
window.cargarDatosPrueba = async function() {
  if (!currentUser) { alert('Inicia sesion primero'); return; }
  if (!confirm('Esto creara 8 envios de prueba, 1 paquete y asignara algunos. Continuar?')) return;

  const uid = currentUser.uid;
  const hoy = hoyStr();
  const ayer = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  try {
    // Crear 8 envios courier con diferentes estados
    const envios = [
      { cliente: 'Maria Lopez', telefono: '55501234', direccion: 'Zona 1, Ciudad de Guatemala', montoCobrar: 150, estado: 'pendiente', liquidada: false },
      { cliente: 'Juan Perez', telefono: '55505678', direccion: 'Mixco, Guatemala', montoCobrar: 225, estado: 'pendiente', liquidada: false },
      { cliente: 'Ana Garcia', telefono: '55509012', direccion: 'Villa Nueva, Guatemala', montoCobrar: 180, estado: 'en_camino', liquidada: false },
      { cliente: 'Carlos Ruiz', telefono: '55503456', direccion: 'San Juan Sacatepequez', montoCobrar: 320, estado: 'entregado', liquidada: false },
      { cliente: 'Sofia Martinez', telefono: '55507890', direccion: 'Antigua Guatemala', montoCobrar: 110, estado: 'entregado', liquidada: false },
      { cliente: 'Pedro Hernandez', telefono: '55502345', direccion: 'Quetzaltenango', montoCobrar: 275, estado: 'entregado', liquidada: true, fechaLiquidacion: new Date().toISOString() },
      { cliente: 'Laura Mendoza', telefono: '55506789', direccion: 'Escuintla', montoCobrar: 95, estado: 'entregado', liquidada: true, fechaLiquidacion: new Date().toISOString() },
      { cliente: 'Roberto Flores', telefono: '55500123', direccion: 'Coban, Alta Verapaz', montoCobrar: 200, estado: 'fallido', liquidada: false },
    ];

    const envioIds = [];
    for (const e of envios) {
      const docRef = await addDoc(collection(firestore, 'envios'), {
        userId: uid,
        cliente: e.cliente,
        telefono: e.telefono,
        direccion: e.direccion,
        tipo: 'courier',
        estado: e.estado,
        fechaProgramada: e.estado === 'entregado' || e.estado === 'fallido' ? ayer : hoy,
        horaProgramada: '',
        numeroGuia: '',
        paqueteGuiaId: null,
        montoCobrar: e.montoCobrar,
        montoCobrado: e.estado === 'entregado' ? e.montoCobrar : 0,
        liquidada: e.liquidada,
        fechaLiquidacion: e.fechaLiquidacion || '',
        notas: '',
        calendarEventId: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      envioIds.push(docRef.id);
      console.log(`Envio creado: ${e.cliente} (${e.estado}) -> ${docRef.id}`);
    }

    // Crear 1 paquete de guias
    const paqRef = await addDoc(collection(firestore, 'guias'), {
      userId: uid,
      comprobante: '1260333914',
      capacidad: 10,
      costo: 350,
      fechaPago: hoy,
      notas: 'Paquete de prueba',
      createdAt: new Date().toISOString()
    });
    console.log('Paquete creado:', paqRef.id);

    // Asignar los primeros 5 envios al paquete
    for (let i = 0; i < 5; i++) {
      await updateDoc(doc(firestore, 'envios', envioIds[i]), { paqueteGuiaId: paqRef.id });
      console.log(`Envio ${envios[i].cliente} asignado al paquete`);
    }

    alert('Datos de prueba creados:\n- 8 envios (2 pendientes, 1 en camino, 4 entregados, 1 fallido)\n- 2 ya liquidados, 2 sin liquidar\n- 1 paquete con 5 envios asignados\n- 3 envios sin paquete');
    await cargarTodo();
  } catch (err) {
    console.error('Error creando datos de prueba:', err);
    alert('Error: ' + err.message);
  }
};

// Funcion para limpiar datos de prueba
window.limpiarDatos = async function() {
  if (!currentUser) return;
  if (!confirm('ELIMINAR TODOS los envios y paquetes? Esto no se puede deshacer.')) return;

  try {
    for (const e of enviosCache) {
      await deleteDoc(doc(firestore, 'envios', e.id));
    }
    for (const g of guiasCache) {
      await deleteDoc(doc(firestore, 'guias', g.id));
    }
    alert('Todos los datos eliminados');
    await cargarTodo();
  } catch (err) {
    alert('Error: ' + err.message);
  }
};

// Recargar alarmas cada minuto
setInterval(() => { renderDashboard(); }, 60000);

// Registrar Service Worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(err => {
    console.warn('[EnviosApp] SW registro fallido:', err);
  });
}
