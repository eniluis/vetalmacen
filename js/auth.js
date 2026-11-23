// js/auth.js
import { supabase, SESSION_KEY, RANCH_NAMES, state } from './config.js';

const ROLES_PERMITIDOS_ALMACEN = ['ADMIN', 'DIESEL', 'ALMACEN', 'FARMACIA'];

export async function cargarRanchosActivos() {
    const { data, error } = await supabase
        .from('ranchos')
        .select('id_rancho, nombre')
        .eq('activo', true)
        .order('nombre');

    if (error || !data || data.length === 0) {
        return Object.entries(RANCH_NAMES).map(([id_rancho, nombre]) => ({
            id_rancho,
            nombre
        }));
    }
    return data;
}

export async function iniciarSesionConPin(idRancho, pin) {
    const { data, error } = await supabase
        .from('usuarios_roles')
        .select('id_usuario, nombre, rol, id_rancho, activo')
        .eq('pin', pin.trim())
        .eq('activo', true)
        .or(`id_rancho.eq.${idRancho},id_rancho.is.null`);

    if (error) throw error;

    if (!data || data.length === 0) {
        throw new Error(`PIN incorrecto o sin permiso para ${RANCH_NAMES[idRancho] || idRancho}.`);
    }

    const candidatos = data.filter((u) => ROLES_PERMITIDOS_ALMACEN.includes(u.rol));

    if (candidatos.length === 0) {
        throw new Error('Tu rol no tiene acceso al módulo de Farmacia y Almacén.');
    }

    const usuarioElegido =
        candidatos.find((u) => u.id_rancho === idRancho) || candidatos[0];

    const sesion = {
        id_usuario: usuarioElegido.id_usuario,
        nombre: usuarioElegido.nombre,
        rol: usuarioElegido.rol,
        id_rancho: idRancho
    };

    state.currentUser = sesion;
    state.activeRanchId = idRancho;
    localStorage.setItem(SESSION_KEY, JSON.stringify(sesion));
    return sesion;
}

export function restaurarSesion() {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const sesion = JSON.parse(raw);
    state.currentUser = sesion;
    state.activeRanchId = sesion.id_rancho;
    return sesion;
}

export function cerrarSesion() {
    state.currentUser = null;
    localStorage.removeItem(SESSION_KEY);
}