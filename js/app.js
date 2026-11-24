// js/app.js
import {
    RANCH_NAMES,
    COMPRAS_WHATSAPP,
    CATEGORIAS_ALMACEN,
    AREAS_DESTINO_SALIDA,
    UNIDADES_MEDIDA,
    state
} from './config.js?v=10';
import { cargarRanchosActivos, iniciarSesionConPin, restaurarSesion, cerrarSesion } from './auth.js?v=10';
import { DualScanner } from './scanner.js?v=10';
import {
    cargarColaOffline,
    sincronizarColaOffline,
    generarCodigoInterno,
    buscarProductoPorCodigo,
    buscarProductosPorNombre,
    registrarEntradaCompleta,
    registrarSalidaOMerma,
    registrarTraspasoEntreRanchos,
    ajustarStockLoteAdmin,
    actualizarProductoCatalogo,
    obtenerExistenciasRancho,
    obtenerHistorialKardex,
    obtenerAlertasRancho,
    obtenerMovimientosPendientes,
    marcarMovimientosExportados,
    obtenerResumenGlobalRanchos
} from './inventory.js?v=10';
import { mostrarToast } from './ui.js?v=10';

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

    if (sesion.rol === 'ADMIN') {
        document.querySelectorAll('.admin-only').forEach((el) => el.classList.remove('hidden'));
    }

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
    if (vista === 'kardex') renderVistaKardex(container);
    if (vista === 'alertas') renderVistaAlertas(container);
    if (vista === 'sincronizacion') renderVistaSincronizacion(container);
    if (vista === 'global' && state.currentUser.rol === 'ADMIN') renderVistaGlobalAdmin(container);
}

// ============================================================================
// UTILIDAD: IMPRIMIR ETIQUETA CODE128 (DESDE ALTA O DESDE EXISTENCIAS)
// ============================================================================
function imprimirEtiquetaCodigo(codigo, nombreProducto, subtexto = '') {
    if (!window.JsBarcode) {
        mostrarToast('Librería de códigos de barra aún cargando.', 'warning');
        return;
    }

    const tempSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    try {
        window.JsBarcode(tempSvg, codigo, {
            format: 'CODE128',
            width: 2,
            height: 48,
            displayValue: true,
            fontSize: 13,
            margin: 4
        });
    } catch (e) {
        mostrarToast('Código no compatible para etiqueta de barras.', 'error');
        return;
    }

    const win = window.open('', '_blank', 'width=400,height=320');
    win.document.write(`
        <html><body style="font-family:sans-serif;text-align:center;padding:18px;">
            <div style="font-weight:bold;font-size:14px;margin-bottom:4px;">${nombreProducto || 'VetAlmacén'}</div>
            ${subtexto ? `<div style="font-size:11px;color:#475569;margin-bottom:6px;">${subtexto}</div>` : ''}
            ${tempSvg.outerHTML}
            <script>window.onload = () => { window.print(); window.close(); };<\/script>
        </body></html>
    `);
    win.document.close();
}

// ============================================================================
// VISTA 1: ESCÁNER, SALIDAS, MERMAS Y TRASPASOS ENTRE RANCHOS
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
          Escanea un código de barras con la cámara o pistola láser, o búscalo por nombre para registrar salidas, entradas o traspasos.
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
        const otrosRanchos = Object.entries(RANCH_NAMES)
            .filter(([k]) => k !== state.activeRanchId)
            .map(([k, nom]) => `<option value="${k}">${nom}</option>`)
            .join('');

        panel.innerHTML = `
      <div class="bg-white p-5 rounded-2xl shadow-sm border border-slate-200 space-y-5">
        <div class="flex justify-between items-start border-b border-slate-100 pb-4">
          <div>
            <div class="flex items-center gap-2">
                <span class="text-xs font-mono bg-slate-100 px-2 py-0.5 rounded text-slate-600">${producto.codigo_barras}</span>
                <button type="button" id="btn-reimprimir-scan" class="text-xs text-slate-500 hover:text-slate-900 underline">🖨️ Etiqueta</button>
            </div>
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
              <select id="mov-tipo" class="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm font-medium">
                <option value="SALIDA">Salida / Consumo Interno</option>
                <option value="TRASPASO">🚚 Traspaso a Otro Rancho</option>
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
            <div id="box-destino-interno">
              <label class="block text-xs font-semibold text-slate-500 mb-1">Área Destino</label>
              <select id="mov-destino-area" class="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm">
                ${opcionesDestino}
              </select>
            </div>
            <div id="box-destino-rancho" class="hidden">
              <label class="block text-xs font-semibold text-emerald-700 mb-1">Rancho Destino *</label>
              <select id="mov-rancho-destino" class="w-full rounded-xl border border-emerald-400 bg-emerald-50/50 px-3 py-2.5 text-sm font-semibold">
                ${otrosRanchos}
              </select>
            </div>
          </div>

          <div>
            <label class="block text-xs font-semibold text-slate-500 mb-1">Detalle / Corral / Chofer o Nota (Opcional)</label>
            <input id="mov-motivo" type="text" placeholder="Ej. Corral 4 / Entrega a médico"
              class="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm" />
          </div>

          <div class="flex flex-wrap gap-3 pt-2">
            <button type="submit" id="btn-submit-mov" ${!producto.lotes.length ? 'disabled' : ''} 
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

        document.getElementById('btn-reimprimir-scan').addEventListener('click', () => {
            imprimirEtiquetaCodigo(producto.codigo_barras, producto.nombre, producto.principio_activo || '');
        });

        const selectTipo = document.getElementById('mov-tipo');
        selectTipo.addEventListener('change', () => {
            const esTraspaso = selectTipo.value === 'TRASPASO';
            document.getElementById('box-destino-interno').classList.toggle('hidden', esTraspaso);
            document.getElementById('box-destino-rancho').classList.toggle('hidden', !esTraspaso);
            document.getElementById('btn-submit-mov').textContent = esTraspaso
                ? '🚚 Ejecutar Traspaso entre Ranchos'
                : 'Registrar Salida / Merma';
        });

        document.getElementById('form-movimiento-rapido').addEventListener('submit', async (e) => {
            e.preventDefault();
            const tipo = selectTipo.value;
            const cantidadVal = document.getElementById('mov-cantidad').value;
            const loteId = document.getElementById('mov-lote').value;
            const detalle = document.getElementById('mov-motivo').value.trim();

            try {
                if (tipo === 'TRASPASO') {
                    const ranchoDest = document.getElementById('mov-rancho-destino').value;
                    await registrarTraspasoEntreRanchos({
                        producto,
                        id_lote_interno: loteId,
                        rancho_origen: state.activeRanchId,
                        rancho_destino: ranchoDest,
                        cantidad: cantidadVal,
                        nota: detalle,
                        id_usuario: state.currentUser.id_usuario
                    });
                    mostrarToast(`Traspaso enviado a ${RANCH_NAMES[ranchoDest]}.`, 'success');
                    await actualizarContadorAlertas();
                    procesarCodigoEscaneado(producto.codigo_barras);
                    return;
                }

                const area = document.getElementById('mov-destino-area').value;
                const motivoFinal = detalle ? `${area} - ${detalle}` : area;

                const res = await registrarSalidaOMerma({
                    codigo_barras: producto.codigo_barras,
                    id_lote_interno: loteId,
                    id_rancho: state.activeRanchId,
                    tipo_movimiento: tipo,
                    cantidad: cantidadVal,
                    motivo_destino: motivoFinal,
                    id_usuario: state.currentUser.id_usuario
                });

                if (res.offline) {
                    mostrarToast('Guardado offline. Se enviará al recuperar señal.', 'warning');
                } else {
                    mostrarToast('Movimiento registrado correctamente.', 'success');
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
// VISTA 2: ALTA DE PRODUCTO (CON ALMACÉN DESTINO VISIBLE Y SELECTOR ADMIN)
// ============================================================================
function renderFormularioAltaOEntrada(container, codigoPrecargado = '', productoExistente = null) {
    const esAltaSinEscaneo = !codigoPrecargado && !productoExistente;
    const codigoInicial = codigoPrecargado || generarCodigoInterno();
    const esAdmin = state.currentUser && state.currentUser.rol === 'ADMIN';

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

    const selectorRanchoAlta = esAdmin
        ? `<select id="alta-rancho" class="rounded-lg border border-emerald-300 bg-white px-2.5 py-1 text-xs font-bold text-emerald-900">
            ${Object.entries(RANCH_NAMES).map(([k, nom]) => `<option value="${k}" ${state.activeRanchId === k ? 'selected' : ''}>${nom}</option>`).join('')}
           </select>`
        : `<span class="font-bold text-emerald-900">${RANCH_NAMES[state.activeRanchId] || state.activeRanchId}</span>`;

    container.innerHTML = `
    <form id="form-alta-entrada" class="bg-white p-5 rounded-2xl shadow-sm border border-slate-200 space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="font-bold text-lg text-slate-800">
          ${productoExistente ? `Registrar Entrada: ${productoExistente.nombre}` : 'Alta de Producto y Entrada'}
        </h3>
        <div class="flex flex-wrap items-center gap-2">
          <div class="flex items-center gap-1.5 bg-emerald-50 border border-emerald-200 px-3 py-1 rounded-xl text-xs">
            <span class="text-emerald-700">📍 Almacén destino:</span>
            ${selectorRanchoAlta}
          </div>
          <span class="text-xs ${esAltaSinEscaneo ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-700'} px-2.5 py-1 rounded-full font-semibold">
            ${esAltaSinEscaneo ? 'Código automático' : 'Código escaneado'}
          </span>
        </div>
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
        const nombreProd = document.getElementById('alta-nombre').value.trim() || 'Producto VetAlmacén';
        const loteTxt = document.getElementById('alta-lote').value.trim();
        const cadTxt = document.getElementById('alta-caducidad').value;
        const sub = [loteTxt ? `Lote: ${loteTxt}` : '', cadTxt ? `Cad: ${cadTxt}` : ''].filter(Boolean).join(' • ');
        imprimirEtiquetaCodigo(codigoInicial, nombreProd, sub);
    });

    document.getElementById('form-alta-entrada').addEventListener('submit', async (e) => {
        e.preventDefault();
        const ranchoDestino = document.getElementById('alta-rancho')
            ? document.getElementById('alta-rancho').value
            : state.activeRanchId;

        try {
            const res = await registrarEntradaCompleta({
                codigo_barras: codigoInicial,
                nombre: document.getElementById('alta-nombre').value.trim(),
                principio_activo: document.getElementById('alta-principio').value.trim(),
                categoria: document.getElementById('alta-categoria').value,
                unidad_medida: document.getElementById('alta-unidad').value,
                stock_minimo: document.getElementById('alta-minimo').value,
                id_rancho: ranchoDestino,
                numero_lote: document.getElementById('alta-lote').value.trim(),
                fecha_caducidad: document.getElementById('alta-caducidad').value || null,
                ubicacion_anaquel: document.getElementById('alta-anaquel').value.trim(),
                cantidad: document.getElementById('alta-cantidad').value,
                id_usuario: state.currentUser.id_usuario
            });

            if (res.offline) {
                mostrarToast('Guardado offline. Se subirá al recuperar red.', 'warning');
            } else {
                mostrarToast(`Entrada registrada en ${RANCH_NAMES[ranchoDestino] || ranchoDestino}.`, 'success');
                await actualizarContadorAlertas();
                procesarCodigoEscaneado(codigoInicial);
            }
        } catch (err) {
            mostrarToast(err.message, 'error');
        }
    });
}

// ============================================================================
// VISTA 3: EXISTENCIAS (CON BUSCADOR, REIMPRESIÓN DE ETIQUETA Y AJUSTES ADMIN)
// ============================================================================
async function renderVistaExistencias(container) {
    container.innerHTML = `<p class="text-slate-500 text-sm">Cargando inventario...</p>`;
    const ranchoNombre = RANCH_NAMES[state.activeRanchId] || state.activeRanchId;
    const esAdmin = state.currentUser && state.currentUser.rol === 'ADMIN';

    try {
        const lotes = await obtenerExistenciasRancho(state.activeRanchId);

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

                const btnAdminHtml = esAdmin
                    ? `
                      <button type="button" data-lote-id="${l.id_lote_interno}" data-code="${l.codigo_barras}" data-nombre="${(prod.nombre || '').replace(/"/g, '"')}" data-actual="${l.existencia_actual}"
                        class="btn-ajustar-lote text-xs bg-amber-100 hover:bg-amber-200 text-amber-900 px-2 py-1 rounded-lg font-semibold">
                        ⚖️ Ajustar
                      </button>
                      <button type="button" data-code="${l.codigo_barras}"
                        class="btn-editar-prod text-xs bg-slate-200 hover:bg-slate-300 text-slate-800 px-2 py-1 rounded-lg font-semibold">
                        ✏️ Editar
                      </button>
                    `
                    : '';

                return `
            <tr class="border-b border-slate-100 hover:bg-slate-50" data-cat="${prod.categoria || ''}">
              <td class="py-3 px-4 font-mono text-xs">${l.codigo_barras}</td>
              <td class="py-3 px-4">
                <div class="font-semibold text-slate-800">${prod.nombre || ''}</div>
                <div class="text-xs text-slate-400">${prod.principio_activo || ''} ${l.ubicacion_anaquel ? `• 📍 ${l.ubicacion_anaquel}` : ''}</div>
              </td>
              <td class="py-3 px-4 text-xs">${l.numero_lote}</td>
              <td class="py-3 px-4 text-xs">${badgeCaducidad}</td>
              <td class="py-3 px-4 font-bold text-emerald-700">${l.existencia_actual} ${prod.unidad_medida || ''}</td>
              <td class="py-3 px-4 text-right whitespace-nowrap space-x-1">
                <button type="button" data-code="${l.codigo_barras}" data-nombre="${(prod.nombre || '').replace(/"/g, '"')}" data-lote="${l.numero_lote}" data-cad="${l.fecha_caducidad || ''}"
                  class="btn-print-row text-xs bg-slate-800 hover:bg-slate-900 text-white px-2.5 py-1 rounded-lg font-medium">
                  🖨️ Etiqueta
                </button>
                ${btnAdminHtml}
              </td>
            </tr>
          `;
            })
            .join('');

        const opcionesFiltroCat = [
            `<option value="TODAS">Todas las categorías</option>`,
            ...CATEGORIAS_ALMACEN.map((c) => `<option value="${c.code}">${c.label}</option>`)
        ].join('');

        container.innerHTML = `
        <div id="admin-edit-box" class="mb-4"></div>
        <div class="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          <div class="p-4 border-b border-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div>
                <h2 class="font-bold text-slate-800">Existencias por Lote — ${ranchoNombre}</h2>
                <span class="text-xs text-slate-500">${lotes.length} lotes activos</span>
            </div>
            <div class="flex flex-wrap gap-2">
                <input id="filtro-existencias-txt" type="text" placeholder="Buscar producto, lote o anaquel..."
                    class="rounded-xl border border-slate-300 px-3 py-1.5 text-xs focus:border-emerald-600 focus:outline-none" />
                <select id="filtro-existencias-cat" class="rounded-xl border border-slate-300 px-3 py-1.5 text-xs">
                    ${opcionesFiltroCat}
                </select>
            </div>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-left text-sm">
              <thead class="bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th class="py-3 px-4">Código</th>
                  <th class="py-3 px-4">Producto / Ubicación</th>
                  <th class="py-3 px-4">Lote</th>
                  <th class="py-3 px-4">Caducidad</th>
                  <th class="py-3 px-4">Existencia</th>
                  <th class="py-3 px-4 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody id="tbody-existencias">${filas}</tbody>
            </table>
          </div>
        </div>
      `;

        const filtrarTabla = () => {
            const q = document.getElementById('filtro-existencias-txt').value.toLowerCase().trim();
            const cat = document.getElementById('filtro-existencias-cat').value;
            document.querySelectorAll('#tbody-existencias tr').forEach((tr) => {
                const matchTxt = tr.textContent.toLowerCase().includes(q);
                const matchCat = cat === 'TODAS' || tr.dataset.cat === cat;
                tr.style.display = matchTxt && matchCat ? '' : 'none';
            });
        };
        document.getElementById('filtro-existencias-txt').addEventListener('input', filtrarTabla);
        document.getElementById('filtro-existencias-cat').addEventListener('change', filtrarTabla);

        container.querySelectorAll('.btn-print-row').forEach((btn) => {
            btn.addEventListener('click', () => {
                const sub = [btn.dataset.lote ? `Lote: ${btn.dataset.lote}` : '', btn.dataset.cad ? `Cad: ${btn.dataset.cad}` : '']
                    .filter(Boolean)
                    .join(' • ');
                imprimirEtiquetaCodigo(btn.dataset.code, btn.dataset.nombre, sub);
            });
        });

        if (esAdmin) {
            container.querySelectorAll('.btn-ajustar-lote').forEach((btn) => {
                btn.addEventListener('click', async () => {
                    const actual = btn.dataset.actual;
                    const nuevaStr = prompt(
                        `AJUSTE FÍSICO ADMIN\nProducto: ${btn.dataset.nombre}\nExistencia en sistema: ${actual}\n\nEscribe la cantidad física real:`,
                        actual
                    );
                    if (nuevaStr === null || nuevaStr.trim() === '') return;

                    const nuevaNum = Number(nuevaStr);
                    if (isNaN(nuevaNum) || nuevaNum < 0) {
                        mostrarToast('Cantidad inválida.', 'error');
                        return;
                    }

                    const motivo = prompt('Motivo del ajuste (ej. Conteo físico mensual / Frasco roto):', 'Conteo físico');
                    try {
                        await ajustarStockLoteAdmin({
                            id_lote_interno: btn.dataset.loteId,
                            codigo_barras: btn.dataset.code,
                            id_rancho: state.activeRanchId,
                            existencia_anterior: actual,
                            existencia_nueva: nuevaNum,
                            motivo: motivo || 'Conteo físico',
                            id_usuario: state.currentUser.id_usuario
                        });
                        mostrarToast('Inventario ajustado y registrado en Kardex.', 'success');
                        await actualizarContadorAlertas();
                        renderVistaExistencias(container);
                    } catch (err) {
                        mostrarToast(err.message, 'error');
                    }
                });
            });

            container.querySelectorAll('.btn-editar-prod').forEach((btn) => {
                btn.addEventListener('click', async () => {
                    const prod = await buscarProductoPorCodigo(btn.dataset.code, state.activeRanchId);
                    if (!prod) return;

                    const editBox = document.getElementById('admin-edit-box');
                    editBox.innerHTML = `
                        <form id="form-admin-edit-prod" class="bg-amber-50 border border-amber-300 p-4 rounded-2xl space-y-3">
                            <div class="flex justify-between items-center">
                                <h3 class="font-bold text-sm text-amber-950">✏️ Editar Ficha de Catálogo (${prod.codigo_barras})</h3>
                                <button type="button" id="btn-cancel-edit" class="text-xs text-slate-600 hover:underline">Cerrar</button>
                            </div>
                            <div class="grid grid-cols-1 md:grid-cols-4 gap-3">
                                <div>
                                    <label class="block text-[11px] font-semibold text-slate-600 mb-1">Nombre Comercial</label>
                                    <input id="edit-nombre" type="text" required value="${prod.nombre}" class="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs" />
                                </div>
                                <div>
                                    <label class="block text-[11px] font-semibold text-slate-600 mb-1">Principio Activo</label>
                                    <input id="edit-principio" type="text" value="${prod.principio_activo || ''}" class="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs" />
                                </div>
                                <div>
                                    <label class="block text-[11px] font-semibold text-slate-600 mb-1">Categoría</label>
                                    <select id="edit-cat" class="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs">
                                        ${CATEGORIAS_ALMACEN.map((c) => `<option value="${c.code}" ${prod.categoria === c.code ? 'selected' : ''}>${c.label}</option>`).join('')}
                                    </select>
                                </div>
                                <div>
                                    <label class="block text-[11px] font-semibold text-slate-600 mb-1">Stock Mínimo (${prod.unidad_medida})</label>
                                    <input id="edit-min" type="number" step="0.01" min="0" value="${prod.stock_minimo}" class="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs" />
                                </div>
                            </div>
                            <button type="submit" class="bg-slate-900 hover:bg-emerald-700 text-white text-xs font-semibold px-4 py-2 rounded-xl">
                                Guardar Cambios en Catálogo
                            </button>
                        </form>
                    `;

                    document.getElementById('btn-cancel-edit').onclick = () => (editBox.innerHTML = '');
                    document.getElementById('form-admin-edit-prod').onsubmit = async (ev) => {
                        ev.preventDefault();
                        try {
                            await actualizarProductoCatalogo(prod.codigo_barras, {
                                nombre: document.getElementById('edit-nombre').value.trim(),
                                principio_activo: document.getElementById('edit-principio').value.trim(),
                                categoria: document.getElementById('edit-cat').value,
                                unidad_medida: prod.unidad_medida,
                                stock_minimo: document.getElementById('edit-min').value
                            });
                            mostrarToast('Producto actualizado correctamente.', 'success');
                            await actualizarContadorAlertas();
                            renderVistaExistencias(container);
                        } catch (err) {
                            mostrarToast(err.message, 'error');
                        }
                    };
                });
            });
        }
    } catch (err) {
        container.innerHTML = `<div class="bg-red-50 border border-red-200 text-red-700 p-4 rounded-xl text-sm">Error al cargar existencias: ${err.message}</div>`;
    }
}

// ============================================================================
// VISTA 4: KARDEX / HISTORIAL DE MOVIMIENTOS Y AUDITORÍA
// ============================================================================
async function renderVistaKardex(container) {
    container.innerHTML = `<p class="text-slate-500 text-sm">Cargando historial de movimientos...</p>`;
    const ranchoNombre = RANCH_NAMES[state.activeRanchId] || state.activeRanchId;

    try {
        const movs = await obtenerHistorialKardex(state.activeRanchId, 150);

        const badgeTipo = (t) => {
            if (t === 'ENTRADA') return `<span class="bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded font-bold text-[11px]">ENTRADA</span>`;
            if (t === 'SALIDA') return `<span class="bg-blue-100 text-blue-800 px-2 py-0.5 rounded font-bold text-[11px]">SALIDA</span>`;
            if (t === 'MERMA') return `<span class="bg-red-100 text-red-800 px-2 py-0.5 rounded font-bold text-[11px]">MERMA</span>`;
            return `<span class="bg-amber-100 text-amber-900 px-2 py-0.5 rounded font-bold text-[11px]">${t}</span>`;
        };

        const filas = movs
            .map((m) => {
                const prod = m.productos_almacen || {};
                const lote = m.inventario_lotes || {};
                const fechaFmt = new Date(m.fecha_movimiento).toLocaleString('es-MX', {
                    day: '2-digit',
                    month: '2-digit',
                    year: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                });

                return `
                <tr class="border-b border-slate-100 hover:bg-slate-50 text-xs" data-tipo="${m.tipo_movimiento}">
                    <td class="py-3 px-4 whitespace-nowrap text-slate-500">${fechaFmt}</td>
                    <td class="py-3 px-4">${badgeTipo(m.tipo_movimiento)}</td>
                    <td class="py-3 px-4">
                        <div class="font-semibold text-slate-800">${prod.nombre || m.codigo_barras}</div>
                        <div class="text-[11px] text-slate-400">Lote: ${lote.numero_lote || 'N/A'}</div>
                    </td>
                    <td class="py-3 px-4 font-bold text-slate-900">${m.cantidad} ${prod.unidad_medida || ''}</td>
                    <td class="py-3 px-4 text-slate-600">${m.motivo_destino || '-'}</td>
                    <td class="py-3 px-4 font-mono text-[11px] text-slate-500">${m.id_usuario}</td>
                </tr>`;
            })
            .join('');

        container.innerHTML = `
        <div class="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
            <div class="p-4 border-b border-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-3">
                <div>
                    <h2 class="font-bold text-slate-800">📜 Kardex de Movimientos — ${ranchoNombre}</h2>
                    <span class="text-xs text-slate-500">Últimos ${movs.length} movimientos registrados</span>
                </div>
                <div class="flex flex-wrap gap-2">
                    <input id="filtro-kardex-txt" type="text" placeholder="Buscar producto, destino o usuario..."
                        class="rounded-xl border border-slate-300 px-3 py-1.5 text-xs focus:border-emerald-600 focus:outline-none" />
                    <select id="filtro-kardex-tipo" class="rounded-xl border border-slate-300 px-3 py-1.5 text-xs">
                        <option value="TODOS">Todos los tipos</option>
                        <option value="ENTRADA">Entradas</option>
                        <option value="SALIDA">Salidas / Traspasos</option>
                        <option value="MERMA">Mermas</option>
                        <option value="AJUSTE">Ajustes Admin</option>
                    </select>
                </div>
            </div>
            <div class="overflow-x-auto">
                <table class="w-full text-left">
                    <thead class="bg-slate-50 text-[11px] uppercase text-slate-500">
                        <tr>
                            <th class="py-3 px-4">Fecha / Hora</th>
                            <th class="py-3 px-4">Tipo</th>
                            <th class="py-3 px-4">Producto / Lote</th>
                            <th class="py-3 px-4">Cantidad</th>
                            <th class="py-3 px-4">Destino / Motivo</th>
                            <th class="py-3 px-4">Usuario</th>
                        </tr>
                    </thead>
                    <tbody id="tbody-kardex">
                        ${filas || '<tr><td colspan="6" class="p-6 text-center text-slate-400 text-sm">Aún no hay movimientos registrados en este rancho.</td></tr>'}
                    </tbody>
                </table>
            </div>
        </div>
        `;

        const filtrarKardex = () => {
            const q = document.getElementById('filtro-kardex-txt').value.toLowerCase().trim();
            const tipo = document.getElementById('filtro-kardex-tipo').value;
            document.querySelectorAll('#tbody-kardex tr').forEach((tr) => {
                const matchTxt = tr.textContent.toLowerCase().includes(q);
                const matchTipo = tipo === 'TODOS' || tr.dataset.tipo === tipo;
                tr.style.display = matchTxt && matchTipo ? '' : 'none';
            });
        };
        document.getElementById('filtro-kardex-txt').addEventListener('input', filtrarKardex);
        document.getElementById('filtro-kardex-tipo').addEventListener('change', filtrarKardex);
    } catch (err) {
        container.innerHTML = `<div class="bg-red-50 text-red-600 p-4 rounded-xl text-sm">Error al cargar Kardex: ${err.message}</div>`;
    }
}

// ============================================================================
// VISTA 5: ALERTAS DE BAJO STOCK Y CADUCIDADES
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
// VISTA 6: EXPORTACIÓN CSV (FASE 2) Y COLA OFFLINE
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

// ============================================================================
// VISTA 7 (EXCLUSIVA ADMIN): TABLERO GLOBAL DE LOS 4 RANCHOS
// ============================================================================
async function renderVistaGlobalAdmin(container) {
    container.innerHTML = `<p class="text-slate-500 text-sm">Consolidando inventarios de los 4 ranchos...</p>`;

    try {
        const { productos, lotes } = await obtenerResumenGlobalRanchos();
        const ranchKeys = Object.keys(RANCH_NAMES);
        const hoy = new Date();

        const tarjetasRanchos = ranchKeys
            .map((rKey) => {
                const lotesRancho = lotes.filter((l) => l.id_rancho === rKey);
                const bajos = productos.filter((p) => {
                    const tot = lotesRancho
                        .filter((l) => l.codigo_barras === p.codigo_barras)
                        .reduce((acc, l) => acc + Number(l.existencia_actual), 0);
                    return tot <= Number(p.stock_minimo);
                }).length;

                const proxCad = lotesRancho.filter((l) => {
                    if (!l.fecha_caducidad) return false;
                    const dias = Math.ceil((new Date(l.fecha_caducidad) - hoy) / (1000 * 60 * 60 * 24));
                    return dias <= 30;
                }).length;

                const esActivo = state.activeRanchId === rKey;

                return `
                <div class="bg-white p-4 rounded-2xl border ${esActivo ? 'border-emerald-500 ring-2 ring-emerald-500/20' : 'border-slate-200'} shadow-sm flex flex-col justify-between gap-3">
                    <div>
                        <div class="flex items-center justify-between">
                            <span class="font-bold text-slate-900">${RANCH_NAMES[rKey]}</span>
                            ${esActivo ? '<span class="text-[10px] bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full font-bold">ACTIVO</span>' : ''}
                        </div>
                        <div class="mt-2 text-xs text-slate-500 space-y-1">
                            <div>📦 Lotes activos: <b class="text-slate-800">${lotesRancho.length}</b></div>
                            <div>🚨 Bajo stock: <b class="${bajos > 0 ? 'text-red-600' : 'text-emerald-600'}">${bajos}</b></div>
                            <div>⏳ Caducidad ≤30d: <b class="${proxCad > 0 ? 'text-amber-600' : 'text-slate-700'}">${proxCad}</b></div>
                        </div>
                    </div>
                    <button data-switch-ranch="${rKey}" class="btn-switch-ranch w-full text-xs ${esActivo ? 'bg-slate-100 text-slate-500 cursor-default' : 'bg-slate-900 hover:bg-emerald-600 text-white'} font-semibold py-2 rounded-xl transition">
                        ${esActivo ? 'Rancho en sesión' : 'Operar en este rancho'}
                    </button>
                </div>`;
            })
            .join('');

        const filasMatriz = productos
            .map((p) => {
                let sumaGlobal = 0;
                const celdasRanchos = ranchKeys
                    .map((rKey) => {
                        const cant = lotes
                            .filter((l) => l.id_rancho === rKey && l.codigo_barras === p.codigo_barras)
                            .reduce((acc, l) => acc + Number(l.existencia_actual), 0);
                        sumaGlobal += cant;
                        const alerta = cant <= Number(p.stock_minimo);
                        return `<td class="py-3 px-3 text-center font-semibold ${alerta ? 'text-red-600 bg-red-50/40' : 'text-slate-700'}">${cant}</td>`;
                    })
                    .join('');

                return `
                <tr class="border-b border-slate-100 hover:bg-slate-50 text-xs">
                    <td class="py-3 px-4">
                        <div class="font-bold text-slate-900">${p.nombre}</div>
                        <div class="text-[11px] text-slate-400 font-mono">${p.codigo_barras} • ${p.unidad_medida} (Mín: ${p.stock_minimo})</div>
                    </td>
                    ${celdasRanchos}
                    <td class="py-3 px-4 text-center font-extrabold text-emerald-700 bg-emerald-50/30">${sumaGlobal}</td>
                </tr>`;
            })
            .join('');

        container.innerHTML = `
        <div class="space-y-6">
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                    <h2 class="font-bold text-xl text-slate-900">🏢 Tablero Global Multi-Rancho (Admin)</h2>
                    <p class="text-xs text-slate-500">Comparativo en tiempo real de existencias y alertas en los 4 almacenes.</p>
                </div>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                ${tarjetasRanchos}
            </div>

            <div class="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
                <div class="p-4 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <h3 class="font-bold text-slate-800 text-sm">Matriz Consolidada por Producto</h3>
                    <input id="filtro-global-prod" type="text" placeholder="Filtrar producto..." 
                        class="rounded-xl border border-slate-300 px-3 py-1.5 text-xs focus:border-emerald-600 focus:outline-none" />
                </div>
                <div class="overflow-x-auto">
                    <table class="w-full text-left">
                        <thead class="bg-slate-50 text-[11px] uppercase text-slate-500">
                            <tr>
                                <th class="py-3 px-4">Producto</th>
                                ${ranchKeys.map((k) => `<th class="py-3 px-3 text-center">${RANCH_NAMES[k]}</th>`).join('')}
                                <th class="py-3 px-4 text-center text-emerald-800">Total Global</th>
                            </tr>
                        </thead>
                        <tbody id="tbody-global-matriz">
                            ${filasMatriz || '<tr><td colspan="6" class="p-6 text-center text-slate-400 text-sm">Sin productos registrados aún.</td></tr>'}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
        `;

        container.querySelectorAll('.btn-switch-ranch').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const nuevoRancho = btn.dataset.switchRanch;
                if (nuevoRancho === state.activeRanchId) return;

                state.activeRanchId = nuevoRancho;
                state.currentUser.id_rancho = nuevoRancho;
                localStorage.setItem('vetalmacen_user_session_v1', JSON.stringify(state.currentUser));

                const nombre = RANCH_NAMES[nuevoRancho] || nuevoRancho;
                document.getElementById('pc-rancho-badge').textContent = nombre;
                document.getElementById('mob-rancho-badge').textContent = nombre;

                mostrarToast(`Cambiado a ${nombre}`, 'success');
                await actualizarContadorAlertas();
                renderVistaGlobalAdmin(container);
            });
        });

        document.getElementById('filtro-global-prod').addEventListener('input', (e) => {
            const q = e.target.value.toLowerCase().trim();
            document.querySelectorAll('#tbody-global-matriz tr').forEach((tr) => {
                tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
            });
        });
    } catch (err) {
        container.innerHTML = `<div class="bg-red-50 text-red-600 p-4 rounded-xl text-sm">Error al cargar tablero global: ${err.message}</div>`;
    }
}