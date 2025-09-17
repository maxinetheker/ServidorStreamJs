// config/logging.js - Configuración centralizada de logging
const fs = require('fs');
const path = require('path');

// Configuración de logging
const LOG_CONFIG = {
    // Control principal de logging
    ENABLED: true,
    
    // Niveles de log específicos (false = desactivado)
    DEVICE_CONNECTION: false,  // 📱 Logs de conexión/desconexión de dispositivos
    RTMP_VALIDATION: false,    // 🔍 Logs de validación RTMP (MUY VERBOSO)
    STREAM_STATUS: true,       // 🚀 Logs de inicio/parada de streams
    CLIENT_REQUESTS: false,    // 📁 Logs de solicitudes de clientes
    HLS_GENERATION: true,      // ✅ Logs de generación HLS
    ERRORS: true,              // ❌ Logs de errores (siempre recomendado)
    SOCKET_EVENTS: false,      // 🔌 Logs de eventos de Socket.IO
    FFMPEG_OUTPUT: false,      // 🎥 Output de FFmpeg (MUY VERBOSO)
    
    // Configuración de archivos de log
    ERROR_FILE: 'error.log',
    GENERAL_FILE: 'server.log',
    MAX_LOG_SIZE: 10 * 1024 * 1024, // 10MB máximo por archivo de log
};

// Cache para evitar logs repetitivos
const logCache = new Map();
const CACHE_TIMEOUT = 30000; // 30 segundos para evitar logs repetidos

class Logger {
    constructor() {
        this.logDir = path.join(__dirname, '..', 'logs');
        this.ensureLogDir();
    }

    ensureLogDir() {
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
    }

    // Función principal de logging con cache
    log(level, category, message, data = null, useCache = false) {
        if (!LOG_CONFIG.ENABLED || !LOG_CONFIG[category]) {
            return;
        }

        // Usar cache para evitar logs repetitivos
        if (useCache) {
            const cacheKey = `${category}:${message}`;
            const now = Date.now();
            
            if (logCache.has(cacheKey)) {
                const lastLogged = logCache.get(cacheKey);
                if (now - lastLogged < CACHE_TIMEOUT) {
                    return; // Skip este log
                }
            }
            
            logCache.set(cacheKey, now);
        }

        const timestamp = new Date().toISOString();
        const logMessage = data 
            ? `[${timestamp}] ${level}: ${message} - ${JSON.stringify(data, null, 2)}`
            : `[${timestamp}] ${level}: ${message}`;

        // Imprimir en consola
        console.log(logMessage);

        // Escribir a archivo si es error
        if (level === 'ERROR' && LOG_CONFIG.ERRORS) {
            this.writeToFile(LOG_CONFIG.ERROR_FILE, logMessage);
        }
    }

    writeToFile(filename, message) {
        try {
            const filePath = path.join(this.logDir, filename);
            
            // Verificar tamaño del archivo
            if (fs.existsSync(filePath)) {
                const stats = fs.statSync(filePath);
                if (stats.size > LOG_CONFIG.MAX_LOG_SIZE) {
                    // Rotar archivo
                    const backupPath = filePath.replace('.log', `_${Date.now()}.log`);
                    fs.renameSync(filePath, backupPath);
                }
            }
            
            fs.appendFileSync(filePath, message + '\n');
        } catch (error) {
            console.error('Error escribiendo al archivo de log:', error);
        }
    }

    // Métodos específicos para diferentes tipos de logs
    deviceConnection(message, data = null) {
        this.log('INFO', 'DEVICE_CONNECTION', `📱 ${message}`, data);
    }

    rtmpValidation(message, data = null) {
        this.log('DEBUG', 'RTMP_VALIDATION', `🔍 ${message}`, data, true); // Con cache
    }

    streamStatus(message, data = null) {
        this.log('INFO', 'STREAM_STATUS', `🚀 ${message}`, data);
    }

    clientRequest(message, data = null) {
        this.log('DEBUG', 'CLIENT_REQUESTS', `📁 ${message}`, data, true); // Con cache
    }

    hlsGeneration(message, data = null) {
        this.log('INFO', 'HLS_GENERATION', `✅ ${message}`, data);
    }

    error(message, error = null) {
        const errorData = error ? {
            message: error.message,
            stack: error.stack
        } : null;
        this.log('ERROR', 'ERRORS', `❌ ${message}`, errorData);
    }

    socketEvent(message, data = null) {
        this.log('DEBUG', 'SOCKET_EVENTS', `🔌 ${message}`, data, true);
    }

    // Limpiar cache periodicamente
    static clearCache() {
        const now = Date.now();
        for (const [key, timestamp] of logCache.entries()) {
            if (now - timestamp > CACHE_TIMEOUT) {
                logCache.delete(key);
            }
        }
    }
}

// Crear instancia global del logger
const logger = new Logger();

// Limpiar cache cada 5 minutos
setInterval(() => {
    Logger.clearCache();
}, 5 * 60 * 1000);

module.exports = { logger, LOG_CONFIG };
