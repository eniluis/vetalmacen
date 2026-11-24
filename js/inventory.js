// js/inventory.js
import { supabase, OFFLINE_QUEUE_KEY, RANCH_NAMES, state } from './config.js?v=10';

export function cargarColaOffline() {
    try {
        const raw = localStorage.getItem(OFFLINE_QUEUE_KEY);
        state.offlineQueue = raw ? JSON.parse(raw) : [];
    } catch {
        state.offlineQueue = [];
    }
    return state.offlineQueue;
}

function guardarColaOffline() {
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(state.offlineQueue));
}

function encolarOperacionOffline(tipoOperacion, payload) {
    cargarColaOffline();
    state.offlineQueue.push({
        id_local: crypto.randomUUID(),
        tipo_operacion: tipoOperacion,
        payload,
        creado_en: new Date().toISOString()
    });
    guardarColaOffline();
}

export async function sincronizarColaOffline() {
    cargarColaOffline();
    if (!state.offlineQueue.length || !navigator.onLine || !supabase) return 0;

    const pendientes = [...state.offlineQueue];
    const fallidos = [];
    let procesados = 0;

    for (const item of pendientes) {
        try {
            if (item.tipo_operacion === 'ENTRADA_RPC') {
                const { error } = await supabase.rpc('registrar_entrada_escaneo', item.payload);
                if (error) throw error;
            } else if (item.tipo_operacion === 'SALIDA_INSERT') {
                const { error } = await supabase.from('movimientos_inventario').insert(item.payload);
                if (error) throw error;
            }
            procesados++;
        } catch (err) {
            if (err && err.code === '23505') {
                procesados++;
            } else {
                fallidos.push(item);
            }
        }
    }

    state.offlineQueue = fallidos;
    guardarColaOffline();
    return procesados;
}

export function generarCodigoInterno() {
    const timestampPart = Date.now().toString().slice(-4);
    const randomPart = Math.floor(10 + Math.random() * 90);
    return `VET-${timestampPart}${randomPart}`;
}

export async function buscarProductoPorCodigo(codigoBarras, idRancho) {
    const { data: producto, error: errProd } = await supabase
        .from('productos_almacen')
        .select('*')
        .eq('codigo_barras', codigoBarras)
        .maybeSingle();

    if (errProd) throw errProd;
    if (!producto) return null;

    const { data: lotes, error: errLotes } = await supabase
        .from('inventario_lotes')
        .select('*')
        .eq('codigo_barras', codigoBarras)
        .eq('id_rancho', idRancho)
        .gt('existencia_actual', 0)
        .order('fecha_caducidad', { ascending: true, nullsFirst: false });

    if (errLotes) throw errLotes;

    const resultado = {
        ...producto,
        lotes: lotes || [],
        stock_total: (lotes || []).reduce((acc, l) => acc + Number(l.existencia_actual), 0)
    };

    state.selectedProduct = resultado;
    return resultado;
}

export async function buscarProductosPorNombre(termino) {
    const { data, error } = await supabase
        .from('productos_almacen')
        .select('*')
        .eq('activo', true)
        .or(`nombre.ilike.%${termino}%,principio_activo.ilike.%${termino}%`)
        .limit(10);

    if (error) throw error;
    return data || [];
}

export async function registrarEntradaCompleta(datos) {
    const rpcPayload = {
        p_uuid_movimiento: crypto.randomUUID(),
        p_codigo_barras: datos.codigo_barras,
        p_nombre: datos.nombre,
        p_principio_activo: datos.principio_activo || null,
        p_categoria: datos.categoria,
        p_unidad_medida: datos.unidad_medida,
        p_stock_minimo: Number(datos.stock_minimo || 1),
        p_id_rancho: datos.id_rancho,
        p_numero_lote: datos.numero_lote,
        p_fecha_caducidad: datos.fecha_caducidad || null,
        p_ubicacion_anaquel: datos.ubicacion_anaquel || null,
        p_cantidad: Number(datos.cantidad),
        p_motivo_destino: datos.motivo_destino || 'Entrada por escaneo',
        p_id_usuario: datos.id_usuario
    };

    if (!navigator.onLine) {
        encolarOperacionOffline('ENTRADA_RPC', rpcPayload);
        return { offline: true };
    }

    try {
        const { data, error } = await supabase.rpc('registrar_entrada_escaneo', rpcPayload);
        if (error) throw error;
        return { offline: false, data };
    } catch (err) {
        if (!navigator.onLine || (err && err.message && err.message.includes('Failed to fetch'))) {
            encolarOperacionOffline('ENTRADA_RPC', rpcPayload);
            return { offline: true };
        }
        throw err;
    }
}

export async function registrarSalidaOMerma(datos) {
    const insertPayload = {
        uuid_movimiento: crypto.randomUUID(),
        codigo_barras: datos.codigo_barras,
        id_lote_interno: Number(datos.id_lote_interno),
        id_rancho: datos.id_rancho,
        tipo_movimiento: datos.tipo_movimiento,
        cantidad: Number(datos.cantidad),
        motivo_destino: datos.motivo_destino,
        id_usuario: datos.id_usuario
    };

    if (!navigator.onLine) {
        encolarOperacionOffline('SALIDA_INSERT', insertPayload);
        return { offline: true };
    }

    try {
        const { error } = await supabase.from('movimientos_inventario').insert(insertPayload);
        if (error) throw error;
        return { offline: false };
    } catch (err) {
        if (!navigator.onLine || (err && err.message && err.message.includes('Failed to fetch'))) {
            encolarOperacionOffline('SALIDA_INSERT', insertPayload);
            return { offline: true };
        }
        throw err;
    }
}

// ============================================================================
// TRASPASO DIRECTO ENTRE RANCHOS (DESCUENTA ORIGEN Y SUMA EN DESTINO)
// ============================================================================
export async function registrarTraspasoEntreRanchos({
    producto,
    id_lote_interno,
    rancho_origen,
    rancho_destino,
    cantidad,
    nota,
    id_usuario
}) {
    if (!navigator.onLine) {
        throw new Error('Los traspasos entre ranchos requieren conexión a internet activa.');
    }
    if (rancho_origen === rancho_destino) {
        throw new Error('El rancho destino debe ser diferente al rancho origen.');
    }

    const cantNum = Number(cantidad);
    if (cantNum <= 0) throw new Error('La cantidad a traspasar debe ser mayor a 0.');

    const { data: loteOrigen, error: errLote } = await supabase
        .from('inventario_lotes')
        .select('*')
        .eq('id_lote_interno', Number(id_lote_interno))
        .single();

    if (errLote || !loteOrigen) throw new Error('No se encontró el lote origen.');
    if (Number(loteOrigen.existencia_actual) < cantNum) {
        throw new Error(`Stock insuficiente en lote (${loteOrigen.existencia_actual} disponibles).`);
    }

    const nombreOrigen = RANCH_NAMES[rancho_origen] || rancho_origen;
    const nombreDestino = RANCH_NAMES[rancho_destino] || rancho_destino;
    const extraNota = nota ? ` (${nota})` : '';

    // 1. Registrar salida por traspaso en rancho origen
    const { error: errSalida } = await supabase.from('movimientos_inventario').insert({
        uuid_movimiento: crypto.randomUUID(),
        codigo_barras: producto.codigo_barras,
        id_lote_interno: Number(id_lote_interno),
        id_rancho: rancho_origen,
        tipo_movimiento: 'SALIDA',
        cantidad: cantNum,
        motivo_destino: `Traspaso enviado a ${nombreDestino}${extraNota}`,
        id_usuario
    });
    if (errSalida) throw errSalida;

    // 2. Registrar entrada automática en rancho destino con el mismo lote y caducidad
    const { error: errEntrada } = await supabase.rpc('registrar_entrada_escaneo', {
        p_uuid_movimiento: crypto.randomUUID(),
        p_codigo_barras: producto.codigo_barras,
        p_nombre: producto.nombre,
        p_principio_activo: producto.principio_activo || null,
        p_categoria: producto.categoria,
        p_unidad_medida: producto.unidad_medida,
        p_stock_minimo: Number(producto.stock_minimo || 1),
        p_id_rancho: rancho_destino,
        p_numero_lote: loteOrigen.numero_lote,
        p_fecha_caducidad: loteOrigen.fecha_caducidad || null,
        p_ubicacion_anaquel: loteOrigen.ubicacion_anaquel || null,
        p_cantidad: cantNum,
        p_motivo_destino: `Traspaso recibido de ${nombreOrigen}${extraNota}`,
        p_id_usuario: id_usuario
    });
    if (errEntrada) throw errEntrada;
}

// ============================================================================
// HERRAMIENTAS ADMIN: AJUSTE DE INVENTARIO FÍSICO Y EDICIÓN DE PRODUCTO
// ============================================================================
export async function ajustarStockLoteAdmin({
    id_lote_interno,
    codigo_barras,
    id_rancho,
    existencia_anterior,
    existencia_nueva,
    motivo,
    id_usuario
}) {
    const nueva = Number(existencia_nueva);
    const anterior = Number(existencia_anterior);
    if (nueva < 0) throw new Error('La existencia física no puede ser negativa.');

    const diferencia = nueva - anterior;
    if (diferencia === 0) return;

    const { error: errUpdate } = await supabase
        .from('inventario_lotes')
        .update({ existencia_actual: nueva })
        .eq('id_lote_interno', Number(id_lote_interno));

    if (errUpdate) throw errUpdate;

    // Registrar movimiento de auditoría en Kardex sin alterar doble el saldo
    await supabase.from('movimientos_inventario').insert({
        uuid_movimiento: crypto.randomUUID(),
        codigo_barras,
        id_lote_interno: Number(id_lote_interno),
        id_rancho,
        tipo_movimiento: 'AJUSTE',
        cantidad: Math.abs(diferencia),
        motivo_destino: `Ajuste físico Admin (${anterior} → ${nueva}): ${motivo || 'Conteo físico'}`,
        id_usuario
    });
}

export async function actualizarProductoCatalogo(codigoBarras, cambios) {
    const { error } = await supabase
        .from('productos_almacen')
        .update({
            nombre: cambios.nombre,
            principio_activo: cambios.principio_activo || null,
            categoria: cambios.categoria,
            unidad_medida: cambios.unidad_medida,
            stock_minimo: Number(cambios.stock_minimo || 0)
        })
        .eq('codigo_barras', codigoBarras);

    if (error) throw error;
}

// ============================================================================
// CONSULTAS: EXISTENCIAS, ALERTAS, KARDEX, EXPORTACIÓN Y TABLERO GLOBAL
// ============================================================================
export async function obtenerExistenciasRancho(idRancho) {
    const { data, error } = await supabase
        .from('inventario_lotes')
        .select(`
            id_lote_interno,
            codigo_barras,
            numero_lote,
            fecha_caducidad,
            existencia_actual,
            ubicacion_anaquel,
            productos_almacen (
                nombre,
                principio_activo,
                categoria,
                unidad_medida,
                stock_minimo
            )
        `)
        .eq('id_rancho', idRancho)
        .gt('existencia_actual', 0)
        .order('fecha_caducidad', { ascending: true });

    if (error) throw error;
    state.dbLotes = data || [];
    return state.dbLotes;
}

export async function obtenerHistorialKardex(idRancho, limite = 120) {
    const { data, error } = await supabase
        .from('movimientos_inventario')
        .select(`
            id_movimiento,
            codigo_barras,
            tipo_movimiento,
            cantidad,
            motivo_destino,
            fecha_movimiento,
            id_usuario,
            productos_almacen ( nombre, unidad_medida ),
            inventario_lotes ( numero_lote )
        `)
        .eq('id_rancho', idRancho)
        .order('fecha_movimiento', { ascending: false })
        .limit(limite);

    if (error) throw error;
    return data || [];
}

export async function obtenerAlertasRancho(idRancho) {
    const { data: productos, error: errProd } = await supabase
        .from('productos_almacen')
        .select('*')
        .eq('activo', true);

    if (errProd) throw errProd;

    const { data: lotes, error: errLotes } = await supabase
        .from('inventario_lotes')
        .select('*')
        .eq('id_rancho', idRancho);

    if (errLotes) throw errLotes;

    const hoy = new Date();
    const bajoStock = [];
    const caducidades = [];

    for (const prod of productos || []) {
        const lotesProd = (lotes || []).filter((l) => l.codigo_barras === prod.codigo_barras);
        const stockTotal = lotesProd.reduce((acc, l) => acc + Number(l.existencia_actual), 0);

        if (stockTotal <= Number(prod.stock_minimo)) {
            bajoStock.push({
                ...prod,
                stock_total: stockTotal
            });
        }
    }

    for (const lote of lotes || []) {
        if (Number(lote.existencia_actual) <= 0 || !lote.fecha_caducidad) continue;

        const diasRestantes = Math.ceil((new Date(lote.fecha_caducidad) - hoy) / (1000 * 60 * 60 * 24));
        if (diasRestantes <= 30) {
            const prodInfo = (productos || []).find((p) => p.codigo_barras === lote.codigo_barras) || {};
            caducidades.push({
                ...lote,
                nombre_producto: prodInfo.nombre || lote.codigo_barras,
                unidad_medida: prodInfo.unidad_medida || '',
                dias_restantes: diasRestantes
            });
        }
    }

    caducidades.sort((a, b) => a.dias_restantes - b.dias_restantes);

    return { bajoStock, caducidades };
}

export async function obtenerMovimientosPendientes(idRancho) {
    const { data, error } = await supabase
        .from('movimientos_inventario')
        .select(`
            id_movimiento,
            uuid_movimiento,
            codigo_barras,
            tipo_movimiento,
            cantidad,
            motivo_destino,
            fecha_movimiento,
            id_usuario,
            productos_almacen ( nombre, unidad_medida ),
            inventario_lotes ( numero_lote, fecha_caducidad )
        `)
        .eq('id_rancho', idRancho)
        .eq('estatus_sincronizacion', 'PENDIENTE')
        .order('fecha_movimiento', { ascending: true });

    if (error) throw error;
    state.dbPendingMovements = data || [];
    return state.dbPendingMovements;
}

export async function marcarMovimientosExportados(idsMovimientos) {
    if (!idsMovimientos.length) return;
    const { error } = await supabase
        .from('movimientos_inventario')
        .update({
            estatus_sincronizacion: 'EXPORTADO',
            fecha_sincronizacion: new Date().toISOString()
        })
        .in('id_movimiento', idsMovimientos);

    if (error) throw error;
}

export async function obtenerResumenGlobalRanchos() {
    const { data: productos, error: errProd } = await supabase
        .from('productos_almacen')
        .select('*')
        .eq('activo', true)
        .order('nombre');

    if (errProd) throw errProd;

    const { data: lotes, error: errLotes } = await supabase
        .from('inventario_lotes')
        .select('*')
        .gt('existencia_actual', 0)
        .order('fecha_caducidad', { ascending: true });

    if (errLotes) throw errLotes;

    return {
        productos: productos || [],
        lotes: lotes || []
    };
}