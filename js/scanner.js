// js/scanner.js

export class DualScanner {
    constructor(onScanCallback) {
        this.onScan = onScanCallback;
        this.html5QrCode = null;
        this.isCameraRunning = false;
        this.lastScannedCode = null;
        this.lastScanTime = 0;

        // Buffer para lectura por pistola USB/Bluetooth en PC
        this.usbBuffer = '';
        this.lastKeyTime = 0;
        this.handleKeyDown = this.handleKeyDown.bind(this);
    }

    // -------------------------------------------------------------------------
    // 1. MODO PISTOLA LÁSER (PC / ESCRITORIO)
    // -------------------------------------------------------------------------
    enableUsbScanner() {
        window.addEventListener('keydown', this.handleKeyDown);
    }

    disableUsbScanner() {
        window.removeEventListener('keydown', this.handleKeyDown);
    }

    handleKeyDown(e) {
        // Ignorar si el usuario está escribiendo dentro de un input, textarea o select
        const tag = e.target.tagName.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

        const now = Date.now();
        // Las pistolas láser envían caracteres con menos de 50ms de diferencia
        if (now - this.lastKeyTime > 80) {
            this.usbBuffer = '';
        }
        this.lastKeyTime = now;

        if (e.key === 'Enter') {
            if (this.usbBuffer.length >= 3) {
                e.preventDefault();
                const code = this.usbBuffer.trim();
                this.usbBuffer = '';
                this.triggerSuccess(code, 'USB');
            }
        } else if (e.key.length === 1) {
            this.usbBuffer += e.key;
        }
    }

    // -------------------------------------------------------------------------
    // 2. MODO CÁMARA (MÓVIL / TABLET)
    // -------------------------------------------------------------------------
    async startCamera(elementId = 'reader') {
        if (this.isCameraRunning) return;

        const container = document.getElementById(elementId);
        if (!container) return;

        try {
            this.html5QrCode = new Html5Qrcode(elementId);
            const config = {
                fps: 12,
                qrbox: { width: 260, height: 140 },
                aspectRatio: 1.777778
            };

            await this.html5QrCode.start({ facingMode: 'environment' },
                config,
                (decodedText) => {
                    this.handleCameraDetection(decodedText);
                },
                () => {
                    // Errores de frame sin código detectado (se ignoran para no saturar consola)
                }
            );

            this.isCameraRunning = true;
        } catch (err) {
            console.error('No se pudo iniciar la cámara:', err);
            throw new Error('Permiso de cámara denegado o dispositivo sin cámara trasera.');
        }
    }

    async stopCamera() {
        if (this.html5QrCode && this.isCameraRunning) {
            try {
                await this.html5QrCode.stop();
                this.html5QrCode.clear();
            } catch (err) {
                console.warn('Error al detener cámara:', err);
            } finally {
                this.isCameraRunning = false;
            }
        }
    }

    handleCameraDetection(code) {
        const now = Date.now();
        // Evitar disparar 10 veces seguidas mientras el usuario retira el frasco
        if (code === this.lastScannedCode && now - this.lastScanTime < 2200) {
            return;
        }

        this.lastScannedCode = code;
        this.lastScanTime = now;
        this.triggerSuccess(code.trim(), 'CAMARA');
    }

    // -------------------------------------------------------------------------
    // 3. FEEDBACK SENSORIAL Y NOTIFICACIÓN
    // -------------------------------------------------------------------------
    triggerSuccess(code, source) {
        // Vibración en móvil
        if (navigator.vibrate) {
            navigator.vibrate(100);
        }

        // Beep corto estilo escáner de punto de venta
        this.playBeep();

        if (typeof this.onScan === 'function') {
            this.onScan(code, source);
        }
    }

    playBeep() {
        try {
            const ctx = new(window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(1050, ctx.currentTime);
            gain.gain.setValueAtTime(0.1, ctx.currentTime);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + 0.08);
        } catch (_) {
            // Ignorar si el navegador bloquea audio sin interacción previa
        }
    }
}