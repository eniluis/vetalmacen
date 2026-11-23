// js/app.js
import {
    RANCH_NAMES,
    COMPRAS_WHATSAPP,
    CATEGORIAS_ALMACEN,
    AREAS_DESTINO_SALIDA,
    UNIDADES_MEDIDA,
    state
} from './config.js';
import { cargarRanchosActivos, iniciarSesionConPin, restaurarSesion, cerrarSesion } from './auth.js';
import { DualScanner } from './scanner.js';
import {
    cargarColaOffline,
    sincronizarColaOffline,
    generarCodigoInterno,
    buscarProductoPorCodigo,
    buscarProductosPorNombre,
    registrarEntradaCompleta,
    registrarSalidaOMerma,
    obtenerExistenciasRancho,
    obtenerAlertasRancho,
    obtenerMovimientosPendientes,
    marcarMovimientosExportados
} from './inventory.js';
import { mostrarToast } from './ui.js';

let scanner = null;

document.addEventListener('DOMContentLoaded', async() => {
    cargarColaOffline();
    configurarListenersRed();
    await inicializarLogin();

    const sesion = restaurarSesion();
    if (sesion) {
        mostrarApp(sesion);
        await intentarSincronizarOffline();
    }
});

function configurarListenersRed() {
    window.addEventListener('online', async() => {
        state.isOnline = true;
        await intentarSincronizarOffline();
    });

    window.addEventListener('offline', () => {
        state.isOnline = false;
        mostrarToast('Modo sin conexión activado', 'warning');
    });
}

async function intentarSincronizarOffline() {
    const subidos = await sincronizarColaOffline();
    if (subidos > 0) {
        mostrarToast(`Se sincronizaron ${subidos} movimiento(s) pendientes.`, 'success');
        await actualizarContadorAlertas();
        if (state.activeView === 'existencias') renderVistaExistencias(document.getElementById('view-container'));
        if (state.activeView === 'sincronizacion') renderVistaSincronizacion(document.getElementById('view-container'));
    }
}

async function inicializarLogin() {
    const selectRancho = document.getElementById('select-rancho');
    const formLogin = document.getElementById('login-form');
    const errorBox = document.getElementById('login-error');

    const ranchos = await cargarRanchosActivos();
    selectRancho.innerHTML = ranchos
        .map((r) => `<option value="${r.id_rancho}">${RANCH_NAMES[r.id_rancho] || r.nombre}</option>`)
        .join('');

    formLogin.addEventListener('submit', async(e) => {
        e.preventDefault();
        errorBox.classList.add('hidden');
        const idRancho = selectRancho.value;
        const pin = document.getElementById('input-pin').value;

        try {
            const sesion = await iniciarSesionConPin(idRancho, pin);
            mostrarApp(sesion);
        } catch (err) {
            errorBox.textContent = err.message;
            errorBox.classList.remove('hidden');
        }
    });
}

async function mostrarApp(sesion) {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app-shell').classList.remove('hidden');

    const nombreRancho = RANCH_NAMES[sesion.id_rancho] || sesion.id_rancho;
    document.getElementById('pc-rancho-badge').textContent = nombreRancho;
    document.getElementById('mob-rancho-badge').textContent = nombreRancho;
    document.getElementById('pc-user-name').textContent = sesion.nombre;
    document.getElementById('mob-user-name').textContent = sesion.nombre;

    const handleLogout = async() => {
        if (scanner) {
            await scanner.stopCamera();
            scanner.disableUsbScanner();
        }
        cerrarSesion();
        location.reload();
    };
    document.getElementById('btn-logout-pc').onclick = handleLogout;
    document.getElementById('btn-logout-mob').onclick = handleLogout;

    document.querySelectorAll('.nav-btn').forEach((btn) => {
        btn.addEventListener('click', () => cambiarVista(btn.dataset.view));
    });

    scanner = new DualScanner((codigo) => procesarCodigoEscaneado(codigo));
    scanner.enableUsbScanner();

    await actualizarContadorAlertas();
    cambiarVista('escaner');
}

async function actualizarContadorAlertas() {
    try {
        const { bajoStock, caducidades } = await obtenerAlertasRancho(state.activeRanchId);
        const total = bajoStock.length + caducidades.length;

        ['badge-alertas-pc', 'badge-alertas-mob'].forEach((id) => {
            const el = document.getElementById(id);
            if (!el) return;
            if (total > 0) {
                el.textContent = total;
                el.classList.remove('hidden');
            } else {
                el.classList.add('hidden');
            }
        });
    } catch (e) {
        console.warn('No se pudo actualizar contador de alertas:', e);
    }
}

async function cambiarVista(vista) {
    state.activeView = vista;

    document.querySelectorAll('.nav-btn').forEach((btn) => {
        const activo = btn.dataset.view === vista;
        btn.classList.toggle('text-emerald-600', activo);
        btn.classList.toggle('font-semibold', activo);
    });

    if (vista !== 'escaner' && scanner) {
        await scanner.stopCamera();
    }

    const container = document.getElementById('view-container');
    if (vista === 'escaner') renderVistaEscaner(container);
    if (vista === 'existencias') renderVistaExistencias(container);
    if (vista === 'catalogo') renderFormularioAltaOEntrada(container, '');
    if (vista === 'alertas') renderVistaAlertas(container);
    if (vista === 'sincronizacion') renderVistaSincronizacion(container);
}

// ============================================================================
// VISTA 1: ESCÁNER Y BÚSQUEDA POR NOMBRE/PRINCIPIO ACTIVO
// ============================================================================
function renderVistaEscaner(container) {
    container.innerHTML = `
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
      <div class="lg:col-span-5 space-y-4">
        <div class="bg-white p-4 rounded-2xl shadow-sm border border-slate-200">
          <div class="flex items-center justify-between mb-3">
            <h2 class="font-bold text-slate-800">Lector de Código</h2>
            <button id="btn-toggle-cam" class="text-xs bg-emerald-600 text-white px-3 py-1.5 rounded-lg font-medium">
              Activar Cámara
            </button>
          </div>
          
          <div id="reader" class="w-full overflow-hidden rounded-xl bg-slate-900 min-h-[180px] flex items-center justify-center text-slate-400 text-xs text-center px-4">
            Cámara en espera (en PC usa tu pistola láser directo)
          </div>

          <form id="form-buscar-nombre" class="mt-4 flex gap-2">
            <input id="input-buscar-nombre" type="text" placeholder="Buscar producto por nombre o principio activo..." 
              class="flex-1 rounded-xl border border-slate-300 px-3 py-2.5 text-sm focus:border-emerald-600 focus:outline-none" />
            <button type="submit" class="bg-slate-800 text-white px-4 py-2.5 rounded-xl text-sm font-medium">
              Buscar
            </button>
          </form>
          <div id="search-suggestions" class="mt-2 space-y-1"></div>
        </div>
      </div>

      <div id="scan-result-panel" class="lg:col-span-7">
        <div class="bg-white p-8 rounded-2xl border border-dashed border-slate-300 text-center text-slate-400">
          Escanea un código de barras con la cámara o pistola láser, o búscalo por nombre para consultar lotes.
        </div>
      </div>
    </div>
  `;

    const btnCam = document.getElementById('btn-toggle-cam');
    btnCam.addEventListener('click', async() => {
        if (scanner.isCameraRunning) {
            await scanner.stopCamera();
            btnCam.textContent = 'Activar Cámara';
            btnCam.classList.replace('bg-red-600', 'bg-emerald-600');
        } else {
            try {
                await scanner.startCamera('reader');
                btnCam.textContent = 'Detener Cámara';
                btnCam.classList.replace('bg-emerald-600', 'bg-red-600');
            } catch (err) {
                mostrarToast(err.message, 'error');
            }
        }
    });

    document.getElementById('form-buscar-nombre').addEventListener('submit', async(e) => {
        e.preventDefault();
        const val = document.getElementById('input-buscar-nombre').value.trim();
        if (!val) return;

        const sugerenciasBox = document.getElementById('search-suggestions');
        const coincidencias = await buscarProductosPorNombre(val);

        if (coincidencias.length === 1) {
            sugerenciasBox.innerHTML = '';
            procesarCodigoEscaneado(coincidencias[0].codigo_barras);
        } else if (coincidencias.length > 1) {
            sugerenciasBox.innerHTML = coincidencias
                .map(
                    (p) => `
          <button type="button" data-code="${p.codigo_barras}"
            class="btn-sugerencia w-full text-left px-3 py-2 rounded-lg bg-slate-50 hover:bg-emerald-50 border border-slate-200 text-xs flex justify-between">
            <span class="font-semibold text-slate-800">${p.nombre}</span>
            <span class="font-mono text-slate-500">${p.codigo_barras}</span>
          </button>`
                )
                .join('');

            document.querySelectorAll('.btn-sugerencia').forEach((b) => {
                b.addEventListener('click', () => {
                    sugerenciasBox.innerHTML = '';
                    procesarCodigoEscaneado(b.dataset.code);
                });
            });
        } else {
            sugerenciasBox.innerHTML = '';
            mostrarToast('No se encontró ningún producto con ese nombre. Si es nuevo, regístralo en Alta.', 'warning');
        }
    });
}

function generarUrlWhatsappReorden(producto, stockActual) {
    const ranchoNombre = RANCH_NAMES[state.activeRanchId] || state.activeRanchId;
    const texto = [
            `*SOLICITUD DE REORDEN - VETALMACÉN*`,
            `*Rancho:* ${ranchoNombre}`,
            `*Producto:* ${producto.nombre}`,
            producto.principio_activo ? `*Principio Activo:* ${producto.principio_activo}` : null,
            `*Código:* ${producto.codigo_barras}`,
            `*Existencia Actual:* ${stockActual} ${producto.unidad_medida} (Mínimo: ${producto.stock_minimo})`,
            `*Solicita:* ${state.currentUser.nombre}`
        ]
        .filter(Boolean)
        .join('\n');

    return `https://wa.me/${COMPRAS_WHATSAPP.phone}?text=${encodeURIComponent(texto)}`;
}

async function procesarCodigoEscaneado(codigo) {
    if (state.activeView !== 'escaner') {
        await cambiarVista('escaner');
    }

    const panel = document.getElementById('scan-result-panel');
    panel.innerHTML = `<div class="bg-white p-6 rounded-2xl shadow-sm text-center text-slate-500">Consultando código <b>${codigo}</b>...</div>`;

    try {
        const producto = await buscarProductoPorCodigo(codigo, state.activeRanchId);

        if (!producto) {
            panel.innerHTML = `
        <div class="bg-amber-50 border border-amber-200 p-4 rounded-2xl mb-4 text-sm text-amber-800">
          El código <b>${codigo}</b> no está registrado en el catálogo. Completa los datos para darlo de alta:
        </div>
        <div id="inline-alta-container"></div>
      `;
            renderFormularioAltaOEntrada(document.getElementById('inline-alta-container'), codigo);
            return;
        }

        const stockBajo = producto.stock_total <= producto.stock_minimo;
        const whatsappUrl = generarUrlWhatsappReorden(producto, producto.stock_total);

        const opcionesLotes = producto.lotes.length ?
            producto.lotes
            .map(
                (l) =>
                `<option value="${l.id_lote_interno}">Lote: ${l.numero_lote} | Cad: ${l.fecha_caducidad || 'N/A'} | Disp: ${l.existencia_actual}</option>`
            )
            .join('') :
            `<option value="">Sin existencias en ${RANCH_NAMES[state.activeRanchId]}</option>`;

        const opcionesDestino = AREAS_DESTINO_SALIDA.map((a) => `<option value="${a}">${a}</option>`).join('');

        panel.innerHTML = `
      <div class="bg-white p-5 rounded-2xl shadow-sm border border-slate-200 space-y-5">
        <div class="flex justify-between items-start border-b border-slate-100 pb-4">
          <div>
            <span class="text-xs font-mono bg-slate-100 px-2 py-0.5 rounded text-slate-600">${producto.codigo_barras}</span>
            <h3 class="text-xl font-bold text-slate-900 mt-1">${producto.nombre}</h3>
            <p class="text-sm text-slate-500">${producto.principio_activo || 'Sin principio activo'} • ${producto.categoria}</p>
          </div>
          <div class="text-right">
            <span class="text-xs text-slate-400 block">Stock en ${RANCH_NAMES[state.activeRanchId]}</span>
            <span class="text-2xl font-extrabold ${stockBajo ? 'text-red-600' : 'text-emerald-600'}">
              ${producto.stock_total} <small class="text-xs font-normal">${producto.unidad_medida}</small>
            </span>
          </div>
        </div>

        ${
          stockBajo
            ? `<div class="bg-red-50 border border-red-200 rounded-xl p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <span class="text-xs font-semibold text-red-700">⚠️ Stock en nivel mínimo (${producto.stock_minimo} ${producto.unidad_medida})</span>
                <a href="${whatsappUrl}" target="_blank" rel="noopener"
                  class="inline-flex items-center justify-center gap-1.5 bg-green-600 hover:bg-green-700 text-white text-xs font-semibold px-3 py-2 rounded-lg">
                  📲 Pedir a ${COMPRAS_WHATSAPP.nombre}
                </a>
              </div>`
            : ''
        }

        <form id="form-movimiento-rapido" class="space-y-4">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-semibold text-slate-500 mb-1">Tipo de Movimiento</label>
              <select id="mov-tipo" class="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm">
                <option value="SALIDA">Salida / Consumo</option>
                <option value="MERMA">Merma / Caducado</option>
              </select>
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-500 mb-1">Lote (Prioridad FEFO)</label>
              <select id="mov-lote" required class="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm">
                ${opcionesLotes}
              </select>
            </div>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-semibold text-slate-500 mb-1">Cantidad (${producto.unidad_medida})</label>
              <input id="mov-cantidad" type="number" step="0.01" min="0.01" required placeholder="Ej. 1"
                class="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm" />
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-500 mb-1">Área Destino</label>
              <select id="mov-destino-area" class="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm">
                ${opcionesDestino}
              </select>
            </div>
          </div>

          <div>
            <label class="block text-xs font-semibold text-slate-500 mb-1">Detalle / Corral / Responsable (Opcional)</label>
            <input id="mov-motivo" type="text" placeholder="Ej. Corral 4 / Médico de turno"
              class="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm" />
          </div>

          <div class="flex flex-wrap gap-3 pt-2">
            <button type="submit" ${!producto.lotes.length ? 'disabled' : ''} 
              class="flex-1 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white font-semibold py-3 rounded-xl text-sm">
              Registrar Salida / Merma
            </button>
            <button type="button" id="btn-sumar-lote" 
              class="bg-slate-800 hover:bg-slate-900 text-white font-semibold px-4 py-3 rounded-xl text-sm">
              + Entrada / Nuevo Lote
            </button>
          </div>
        </form>
      </div>
    `;

        document.getElementById('form-movimiento-rapido').addEventListener('submit', async (e) => {
            e.preventDefault();
            const area = document.getElementById('mov-destino-area').value;
            const detalle = document.getElementById('mov-motivo').value.trim();
            const motivoFinal = detalle ? `${area} - ${detalle}` : area;

            try {
                const res = await registrarSalidaOMerma({
                    codigo_barras: producto.codigo_barras,
                    id_lote_interno: document.getElementById('mov-lote').value,
                    id_rancho: state.activeRanchId,
                    tipo_movimiento: document.getElementById('mov-tipo').value,
                    cantidad: document.getElementById('mov-cantidad').value,
                    motivo_destino: motivoFinal,
                    id_usuario: state.currentUser.id_usuario
                });

                if (res.offline) {
                    mostrarToast('Guardado offline. Se enviará al recuperar señal.', 'warning');
                } else {
                    mostrarToast('Salida registrada correctamente.', 'success');
                    await actualizarContadorAlertas();
                    procesarCodigoEscaneado(producto.codigo_barras);
                }
            } catch (err) {
                mostrarToast(err.message, 'error');
            }
        });

        document.getElementById('btn-sumar-lote').addEventListener('click', () => {
            renderFormularioAltaOEntrada(panel, producto.codigo_barras, producto);
        });
    } catch (err) {
        panel.innerHTML = `<div class="bg-red-50 text-red-600 p-4 rounded-xl text-sm">Error: ${err.message}</div>`;
    }
}

// ============================================================================
// VISTA 2: ALTA DE PRODUCTO (SIN INPUT DE CÓDIGO - 100% AUTOMÁTICO / ESCÁNER)
// ============================================================================
function renderFormularioAltaOEntrada(container, codigoPrecargado = '', productoExistente = null) {
    const esAltaSinEscaneo = !codigoPrecargado && !productoExistente;
    const codigoInicial = codigoPrecargado || generarCodigoInterno();

    const nombreVal = productoExistente ? productoExistente.nombre : '';
    const principioVal = productoExistente && productoExistente.principio_activo ? productoExistente.principio_activo : '';
    const catActual = productoExistente ? productoExistente.categoria : '';
    const uniActual = productoExistente ? productoExistente.unidad_medida : '';
    const minActual = productoExistente && productoExistente.stock_minimo !== undefined ? productoExistente.stock_minimo : 2;

    const opcionesCategorias = CATEGORIAS_ALMACEN.map(
        (c) => `<option value="${c.code}" ${catActual === c.code ? 'selected' : ''}>${c.label}</option>`
    ).join('');

    const opcionesUnidades = UNIDADES_MEDIDA.map(
        (u) => `<option value="${u}" ${uniActual === u ? 'selected' : ''}>${u}</option>`
    ).join('');

    container.innerHTML = `
    <form id="form-alta-entrada" class="bg-white p-5 rounded-2xl shadow-sm border border-slate-200 space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="font-bold text-lg text-slate-800">
          ${productoExistente ? `Registrar Entrada: ${productoExistente.nombre}` : 'Alta de Producto y Entrada'}
        </h3>
        <span class="text-xs ${esAltaSinEscaneo ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-700'} px-2.5 py-1 rounded-full font-semibold">
          ${esAltaSinEscaneo ? 'Código generado automáticamente' : 'Código leído por escáner'}
        </span>
      </div>

      <div id="barcode-preview-box" class="bg-slate-50 border border-slate-200 rounded-xl p-3 flex flex-col sm:flex-row items-center justify-between gap-3">
        <svg id="barcode-svg" class="max-h-16"></svg>
        <button type="button" id="btn-imprimir-etiqueta" class="text-xs bg-slate-800 hover:bg-slate-900 text-white px-3.5 py-2.5 rounded-lg font-medium">
          🖨️ Imprimir / Guardar Etiqueta
        </button>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label class="block text-xs font-semibold text-slate-500 mb-1">Nombre Comercial *</label>
          <input id="alta-nombre" type="text" required value="${nombreVal}" ${productoExistente ? 'readonly' : ''}
            class="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm" />
        </div>
        <div>
          <label class="block text-xs font-semibold text-slate-500 mb-1">Principio Activo</label>
          <input id="alta-principio" type="text" value="${principioVal}"
            class="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm" />
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label class="block text-xs font-semibold text-slate-500 mb-1">Categoría *</label>
          <select id="alta-categoria" class="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm">
            ${opcionesCategorias}
          </select>
        </div>
        <div>
          <label class="block text-xs font-semibold text-slate-500 mb-1">Unidad de Medida *</label>
          <select id="alta-unidad" class="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm">
            ${opcionesUnidades}
          </select>
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-5 gap-3 pt-2 border-t border-slate-100">
        <div>
          <label class="block text-xs font-semibold text-slate-500 mb-1">Número de Lote *</label>
          <input id="alta-lote" type="text" required placeholder="Ej. L-2026A"
            class="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm" />
        </div>
        <div>
          <label class="block text-xs font-semibold text-slate-500 mb-1">Caducidad</label>
          <input id="alta-caducidad" type="date"
            class="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm" />
        </div>
        <div>
          <label class="block text-xs font-semibold text-slate-500 mb-1">Cantidad Entra *</label>
          <input id="alta-cantidad" type="number" step="0.01" min="0.01" required
            class="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm" />
        </div>
        <div>
          <label class="block text-xs font-semibold text-slate-500 mb-1">Stock Mínimo</label>
          <input id="alta-minimo" type="number" step="0.01" min="0" value="${minActual}"
            class="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm" />
        </div>
        <div>
          <label class="block text-xs font-semibold text-slate-500 mb-1">Anaquel / Refri</label>
          <input id="alta-anaquel" type="text" placeholder="Ej. Refri 1"
            class="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm" />
        </div>
      </div>

      <button type="submit" class="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold py-3 rounded-xl text-sm">
        Guardar y Sumar al Inventario
      </button>
    </form>
  `;

    if (window.JsBarcode && codigoInicial) {
        try {
            window.JsBarcode('#barcode-svg', codigoInicial, {
                format: 'CODE128',
                width: 2,
                height: 45,
                displayValue: true,
                fontSize: 13,
                margin: 4
            });
        } catch (e) {
            console.warn('Código no válido para barra:', e);
        }
    }

    document.getElementById('btn-imprimir-etiqueta').addEventListener('click', () => {
        const svgHtml = document.getElementById('barcode-svg').outerHTML;
        const nombreProd = document.getElementById('alta-nombre').value.trim() || 'Producto VetAlmacén';
        const win = window.open('', '_blank', 'width=400,height=300');
        win.document.write(`
      <html><body style="font-family:sans-serif;text-align:center;padding:20px;">
        <div style="font-weight:bold;font-size:14px;margin-bottom:6px;">${nombreProd}</div>
        ${svgHtml}
        <script>window.onload = () => { window.print(); window.close(); };<\/script>
      </body></html>
    `);
        win.document.close();
    });

    document.getElementById('form-alta-entrada').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            const res = await registrarEntradaCompleta({
                codigo_barras: codigoInicial,
                nombre: document.getElementById('alta-nombre').value.trim(),
                principio_activo: document.getElementById('alta-principio').value.trim(),
                categoria: document.getElementById('alta-categoria').value,
                unidad_medida: document.getElementById('alta-unidad').value,
                stock_minimo: document.getElementById('alta-minimo').value,
                id_rancho: state.activeRanchId,
                numero_lote: document.getElementById('alta-lote').value.trim(),
                fecha_caducidad: document.getElementById('alta-caducidad').value || null,
                ubicacion_anaquel: document.getElementById('alta-anaquel').value.trim(),
                cantidad: document.getElementById('alta-cantidad').value,
                id_usuario: state.currentUser.id_usuario
            });

            if (res.offline) {
                mostrarToast('Guardado offline. Se subirá al recuperar red.', 'warning');
            } else {
                mostrarToast('Entrada registrada exitosamente.', 'success');
                await actualizarContadorAlertas();
                procesarCodigoEscaneado(codigoInicial);
            }
        } catch (err) {
            mostrarToast(err.message, 'error');
        }
    });
}

// ============================================================================
// VISTA 3: CONSULTA DE EXISTENCIAS
// ============================================================================
async function renderVistaExistencias(container) {
    container.innerHTML = `<p class="text-slate-500 text-sm">Cargando inventario...</p>`;
    const lotes = await obtenerExistenciasRancho(state.activeRanchId);
    const ranchoNombre = RANCH_NAMES[state.activeRanchId] || state.activeRanchId;

    if (!lotes.length) {
        container.innerHTML = `<div class="bg-white p-6 rounded-2xl text-center text-slate-400">No hay existencias registradas en ${ranchoNombre}.</div>`;
        return;
    }

    const hoy = new Date();
    const filas = lotes
        .map((l) => {
            const prod = l.productos_almacen || {};
            let badgeCaducidad = `<span class="text-slate-500">${l.fecha_caducidad || 'Sin caducidad'}</span>`;
            if (l.fecha_caducidad) {
                const dias = Math.ceil((new Date(l.fecha_caducidad) - hoy) / (1000 * 60 * 60 * 24));
                if (dias < 0) {
                    badgeCaducidad = `<span class="bg-red-100 text-red-700 px-2 py-0.5 rounded font-semibold">Vencido (${l.fecha_caducidad})</span>`;
                } else if (dias <= 30) {
                    badgeCaducidad = `<span class="bg-amber-100 text-amber-800 px-2 py-0.5 rounded font-semibold">Próx. (${l.fecha_caducidad})</span>`;
                }
            }

            return `
        <tr class="border-b border-slate-100 hover:bg-slate-50">
          <td class="py-3 px-4 font-mono text-xs">${l.codigo_barras}</td>
          <td class="py-3 px-4">
            <div class="font-semibold text-slate-800">${prod.nombre || ''}</div>
            <div class="text-xs text-slate-400">${prod.principio_activo || ''}</div>
          </td>
          <td class="py-3 px-4 text-xs">${l.numero_lote}</td>
          <td class="py-3 px-4 text-xs">${badgeCaducidad}</td>
          <td class="py-3 px-4 font-bold text-emerald-700">${l.existencia_actual} ${prod.unidad_medida || ''}</td>
        </tr>
      `;
        })
        .join('');

    container.innerHTML = `
    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
      <div class="p-4 border-b border-slate-100 flex justify-between items-center">
        <h2 class="font-bold text-slate-800">Existencias por Lote — ${ranchoNombre}</h2>
        <span class="text-xs bg-emerald-100 text-emerald-800 px-2.5 py-1 rounded-full font-semibold">${lotes.length} lotes activos</span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th class="py-3 px-4">Código</th>
              <th class="py-3 px-4">Producto</th>
              <th class="py-3 px-4">Lote</th>
              <th class="py-3 px-4">Caducidad</th>
              <th class="py-3 px-4">Existencia</th>
            </tr>
          </thead>
          <tbody>${filas}</tbody>
        </table>
      </div>
    </div>
  `;
}

// ============================================================================
// VISTA 4: ALERTAS DE BAJO STOCK Y CADUCIDADES
// ============================================================================
async function renderVistaAlertas(container) {
    container.innerHTML = `<p class="text-slate-500 text-sm">Analizando existencias y caducidades...</p>`;
    const { bajoStock, caducidades } = await obtenerAlertasRancho(state.activeRanchId);
    const ranchoNombre = RANCH_NAMES[state.activeRanchId] || state.activeRanchId;

    const lineasWhatsapp = [
        `*REPORTE DE FALTANTES - VETALMACÉN*`,
        `*Rancho:* ${ranchoNombre}`,
        `*Fecha:* ${new Date().toLocaleDateString('es-MX')}`,
        `---------------------------`,
        ...bajoStock.map(
            (p) => `• *${p.nombre}* (${p.codigo_barras}): Quedan *${p.stock_total}* ${p.unidad_medida} (Mín: ${p.stock_minimo})`
        )
    ];
    const urlWhatsappMasivo = `https://wa.me/${COMPRAS_WHATSAPP.phone}?text=${encodeURIComponent(lineasWhatsapp.join('\n'))}`;

    const htmlBajoStock = bajoStock.length
        ? bajoStock
            .map(
                (p) => `
          <div class="p-3.5 border border-red-200 bg-red-50/60 rounded-xl flex items-center justify-between gap-3">
            <div>
              <div class="font-bold text-slate-900 text-sm">${p.nombre}</div>
              <div class="text-xs text-slate-500 font-mono">${p.codigo_barras} • Mínimo: ${p.stock_minimo} ${p.unidad_medida}</div>
            </div>
            <div class="text-right">
              <span class="text-base font-extrabold text-red-600">${p.stock_total} ${p.unidad_medida}</span>
              <button data-code="${p.codigo_barras}" class="btn-ir-producto block text-xs text-emerald-700 font-semibold hover:underline mt-0.5">
                + Surtir
              </button>
            </div>
          </div>`
            )
            .join('')
        : `<p class="text-sm text-slate-400">Todo el catálogo está por encima del stock mínimo.</p>`;

    const htmlCaducidades = caducidades.length
        ? caducidades
            .map((l) => {
                const vencido = l.dias_restantes < 0;
                return `
            <div class="p-3.5 border ${vencido ? 'border-red-300 bg-red-50' : 'border-amber-200 bg-amber-50/60'} rounded-xl flex items-center justify-between gap-3">
              <div>
                <div class="font-bold text-slate-900 text-sm">${l.nombre_producto}</div>
                <div class="text-xs text-slate-600">Lote: <b>${l.numero_lote}</b> • Existencia: ${l.existencia_actual} ${l.unidad_medida}</div>
              </div>
              <div class="text-right">
                <span class="text-xs font-bold px-2.5 py-1 rounded-full ${vencido ? 'bg-red-600 text-white' : 'bg-amber-500 text-slate-900'}">
                  ${vencido ? `Vencido (${l.fecha_caducidad})` : `Vence en ${l.dias_restantes} d (${l.fecha_caducidad})`}
                </span>
                <button data-code="${l.codigo_barras}" class="btn-ir-producto block ml-auto text-xs text-slate-700 font-semibold hover:underline mt-1">
                  Dar salida / merma
                </button>
              </div>
            </div>`;
            })
            .join('')
        : `<p class="text-sm text-slate-400">No hay lotes vencidos ni próximos a caducar en los próximos 30 días.</p>`;

    container.innerHTML = `
    <div class="space-y-6">
      <div class="bg-white p-5 rounded-2xl shadow-sm border border-slate-200 space-y-4">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-3">
          <div>
            <h2 class="font-bold text-lg text-slate-800">🚨 Productos con Bajo Stock — ${ranchoNombre}</h2>
            <p class="text-xs text-slate-500">Artículos en nivel mínimo o agotados.</p>
          </div>
          ${
            bajoStock.length
              ? `<a href="${urlWhatsappMasivo}" target="_blank" rel="noopener"
                  class="inline-flex items-center justify-center gap-2 bg-green-600 hover:bg-green-700 text-white text-xs font-semibold px-4 py-2.5 rounded-xl">
                  📲 Enviar lista completa a ${COMPRAS_WHATSAPP.nombre}
                </a>`
              : ''
          }
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">${htmlBajoStock}</div>
      </div>

      <div class="bg-white p-5 rounded-2xl shadow-sm border border-slate-200 space-y-4">
        <div class="border-b border-slate-100 pb-3">
          <h2 class="font-bold text-lg text-slate-800">⏳ Alertas de Caducidad (Próximos 30 días)</h2>
          <p class="text-xs text-slate-500">Lotes prioritarios para usar o dar de baja por merma.</p>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">${htmlCaducidades}</div>
      </div>
    </div>
  `;

    container.querySelectorAll('.btn-ir-producto').forEach((btn) => {
        btn.addEventListener('click', () => procesarCodigoEscaneado(btn.dataset.code));
    });
}

// ============================================================================
// VISTA 5: EXPORTACIÓN CSV (FASE 2) Y COLA OFFLINE
// ============================================================================
async function renderVistaSincronizacion(container) {
    const pendientes = await obtenerMovimientosPendientes(state.activeRanchId);
    const offlineCount = cargarColaOffline().length;
    const ranchoNombre = RANCH_NAMES[state.activeRanchId] || state.activeRanchId;

    container.innerHTML = `
    <div class="space-y-4">
      ${
        offlineCount > 0
          ? `<div class="bg-amber-50 border border-amber-200 p-4 rounded-2xl flex items-center justify-between">
              <span class="text-sm text-amber-800">Tienes <b>${offlineCount}</b> movimiento(s) guardados localmente sin subir a Supabase.</span>
              <button id="btn-sync-offline-now" class="bg-amber-600 text-white text-xs font-semibold px-4 py-2 rounded-xl">Subir ahora</button>
            </div>`
          : ''
      }

      <div class="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 class="font-bold text-lg text-slate-800">Exportar para Sistema Principal — ${ranchoNombre}</h2>
          <p class="text-sm text-slate-500">Descarga los movimientos registrados en VetAlmacén listos para cargar en el sistema central.</p>
        </div>
        <button id="btn-exportar-csv" ${!pendientes.length ? 'disabled' : ''}
          class="bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white font-semibold px-5 py-3 rounded-xl text-sm">
          Descargar CSV (${pendientes.length} pendientes)
        </button>
      </div>
    </div>
  `;

    const btnSync = document.getElementById('btn-sync-offline-now');
    if (btnSync) {
        btnSync.addEventListener('click', intentarSincronizarOffline);
    }

    const btnExportar = document.getElementById('btn-exportar-csv');
    if (btnExportar) {
        btnExportar.addEventListener('click', async () => {
            const encabezados = ['ID_MOV', 'RANCHO', 'FECHA', 'TIPO', 'CODIGO_BARRAS', 'PRODUCTO', 'LOTE', 'CADUCIDAD', 'CANTIDAD', 'DESTINO', 'USUARIO'];
            const lineas = pendientes.map((m) => {
                const prod = m.productos_almacen || {};
                const lote = m.inventario_lotes || {};
                return [
                    m.id_movimiento,
                    state.activeRanchId,
                    m.fecha_movimiento,
                    m.tipo_movimiento,
                    m.codigo_barras,
                    `"${prod.nombre || ''}"`,
                    lote.numero_lote || '',
                    lote.fecha_caducidad || '',
                    m.cantidad,
                    `"${m.motivo_destino || ''}"`,
                    m.id_usuario
                ].join(',');
            });

            const csv = '\uFEFF' + [encabezados.join(','), ...lineas].join('\n');
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `VetAlmacen_${state.activeRanchId}_${new Date().toISOString().slice(0, 10)}.csv`;
            a.click();

            await marcarMovimientosExportados(pendientes.map((m) => m.id_movimiento));
            mostrarToast('CSV exportado y movimientos marcados.', 'success');
            renderVistaSincronizacion(container);
        });
    }
}