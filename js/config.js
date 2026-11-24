// js/config.js
export const SUPABASE_URL = 'https://swgqjmowhdkzaodkyvpj.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_1PeWHaPebHs1e_vqsqr6Fw_KvQjSl-e';

export const supabase = window.supabase ?
    window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) :
    null;

export const COMPRAS_WHATSAPP = {
    nombre: 'Compras Matanuzka',
    phone: '5214589890015'
};

export const RANCH_NAMES = {
    EDEN: 'El Edén',
    MATANUZKA: 'Matanuzka',
    ESPERANZA: 'La Esperanza',
    ARADOS: 'Arados'
};

export const OFFLINE_QUEUE_KEY = 'vetalmacen_offline_queue_v1';
export const SESSION_KEY = 'vetalmacen_user_session_v1';

export const CATEGORIAS_ALMACEN = [
    { code: 'ANTIBIOTICOS', label: '💉 Antibióticos', area: 'FARMACIA' },
    { code: 'DESPARASITANTES', label: '🧪 Desparasitantes', area: 'FARMACIA' },
    { code: 'BIOLOGICOS', label: '❄️ Biológicos / Vacunas', area: 'FARMACIA' },
    { code: 'ANTIINFLAMATORIOS', label: '💊 Antiinflamatorios / Analgésicos', area: 'FARMACIA' },
    { code: 'HORMONALES', label: '🧬 Hormonales / Reproducción', area: 'FARMACIA' },
    { code: 'VITAMINAS', label: '⚡ Vitaminas / Minerales / Sueros', area: 'FARMACIA' },
    { code: 'CURACION', label: '🩹 Material de Curación / Jeringas', area: 'FARMACIA' },
    { code: 'ORDENA_INSUMOS', label: '🥛 Selladores / Insumos Ordeña', area: 'ALMACEN' },
    { code: 'REFACCIONES', label: '🔧 Filtros / Refacciones', area: 'ALMACEN' },
    { code: 'GENERAL', label: '📦 Almacén General', area: 'ALMACEN' }
];

export const AREAS_DESTINO_SALIDA = [
    'Establo / Corrales',
    'Sala de Ordeña',
    'Becerreras / Crianza',
    'Hospital / Enfermería',
    'Reproducción / Inseminación',
    'Taller / Maquinaria',
    'Traspaso entre Ranchos',
    'Merma / Caducado'
];

export const UNIDADES_MEDIDA = [
    'Frasco 500 ml',
    'Frasco 250 ml',
    'Frasco 100 ml',
    'Frasco 50 ml',
    'Dosis',
    'Jeringa / Tubo',
    'Caja',
    'Pieza',
    'Bolsa / Sobre',
    'Litro',
    'Kilogramo'
];

export const state = {
    currentUser: null,
    activeRanchId: 'EDEN',
    isOnline: navigator.onLine,
    offlineQueue: [],
    dbProducts: [],
    dbLotes: [],
    dbPendingMovements: [],
    selectedProduct: null,
    selectedCategoryFilter: 'TODAS',
    activeView: 'escaner'
};