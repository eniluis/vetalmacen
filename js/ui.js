// js/ui.js

export function mostrarToast(mensaje, tipo = 'success') {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-xs w-full pointer-events-none';
        document.body.appendChild(container);
    }

    const colores = {
        success: 'bg-emerald-600 text-white',
        error: 'bg-red-600 text-white',
        warning: 'bg-amber-500 text-slate-900 font-semibold',
        info: 'bg-slate-800 text-white'
    };

    const toast = document.createElement('div');
    toast.className = `${colores[tipo] || colores.info} px-4 py-3 rounded-xl shadow-lg text-sm transition-all duration-300 transform translate-y-0 opacity-100`;
    toast.textContent = mensaje;

    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('opacity-0', '-translate-y-2');
        setTimeout(() => toast.remove(), 300);
    }, 3200);
}