const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

// Configuración
const errorLog = true; 
const NGINX_IP = process.env.NGINX_IP || '192.168.101.63';
const NGINX_RTMP_PORT = process.env.NGINX_RTMP_PORT || '1935';
const NGINX_STATS_PORT = process.env.NGINX_STATS_PORT || '8080';
const NGINX_LOCAL_STATS = 'localhost:8080'; 
const WEB_SERVER_URL = 'http://localhost:8000';

// URLs base centralizadas
const NGINX_BASE_URL = `http://${NGINX_IP}`;
const NGINX_HLS_URL = `http://${NGINX_IP}:8000`;

// Función para escribir logs de errores e información
function writeErrorLog(message, error = null, type = 'INFO') {
    if (!errorLog) return;

    const timestamp = new Date().toISOString();
    const logMessage = error
        ? `[${timestamp}] ${type}: ${message} - ${error.message || error}\n${error.stack || ''}\n`
        : `[${timestamp}] ${type}: ${message}\n`;

    const logPath = path.join(__dirname, 'streaming.log');

    try {
        fs.appendFileSync(logPath, logMessage + '\n');
        
        // También escribir a un log específico para on_publish si es relevante
        if (message.includes('[ON_PUBLISH')) {
            const publishLogPath = path.join(__dirname, 'nginx-hooks.log');
            fs.appendFileSync(publishLogPath, logMessage + '\n');
        }
    } catch (writeError) {
        console.error('Error escribiendo al archivo de log:', writeError);
    }
}

// Helper para stringificar objetos de forma segura y truncada (evita logs gigantes)
function safeStringify(obj, maxLen = 1200) {
    try {
        const s = JSON.stringify(obj);
        if (s.length > maxLen) return s.slice(0, maxLen) + '...';
        return s;
    } catch (e) {
        try { return String(obj); } catch (ee) { return '[unstringifiable]'; }
    }
}

// App setup
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { 
        origin: [
            "https://streamff.repo.net.pe", 
            "https://live.streamff.repo.net.pe", 
            "http://localhost:3000", 
            "http://localhost:8000", 
            NGINX_HLS_URL,
            NGINX_BASE_URL
        ], 
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["Origin", "X-Requested-With", "Content-Type", "Accept", "Authorization", "Range", "DNT", "X-CustomHeader", "Keep-Alive", "User-Agent", "If-Modified-Since", "Cache-Control"],
        credentials: true
    },
    allowEIO3: true,
    transports: ['polling', 'websocket'],
    pingTimeout: 60000,
    pingInterval: 25000,
    handlePreflightRequest: (req, res) => {
        const headers = {
            "Access-Control-Allow-Origin": req.headers.origin || "*",
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            "Access-Control-Allow-Headers": "Origin, X-Requested-With, Content-Type, Accept, Authorization, Range, DNT, X-CustomHeader, Keep-Alive, User-Agent, If-Modified-Since, Cache-Control",
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Max-Age": "3600"
        };
        res.writeHead(200, headers);
        res.end();
    }
});

app.use(cors({ 
    origin: [
        "https://streamff.repo.net.pe", 
        "https://live.streamff.repo.net.pe", 
        "http://localhost:8000", 
        "http://localhost:3000",
        "http://localhost", 
        `http://${NGINX_IP}:8000`,
        `http://${NGINX_IP}:3000`,
        NGINX_HLS_URL,
        NGINX_BASE_URL
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
        'Origin', 
        'X-Requested-With', 
        'Content-Type', 
        'Accept', 
        'Authorization', 
        'Range', 
        'DNT', 
        'X-CustomHeader', 
        'Keep-Alive', 
        'User-Agent', 
        'If-Modified-Since', 
        'Cache-Control',
        'Pragma',
        'Expires'
    ],
    credentials: true,
    optionsSuccessStatus: 200
}));

// Middleware adicional para manejar preflight OPTIONS y CORS global
app.use((req, res, next) => {
    const origin = req.get('Origin');
    const allowedOrigins = [
        "https://streamff.repo.net.pe", 
        "https://live.streamff.repo.net.pe", 
        "http://localhost:8000", 
        "http://localhost:3000",
        "http://localhost", 
        `http://${NGINX_IP}:8000`,
        `http://${NGINX_IP}:3000`,
        NGINX_HLS_URL,
        NGINX_BASE_URL
    ];
    
    if (allowedOrigins.includes(origin) || !origin) {
        res.header('Access-Control-Allow-Origin', origin || '*');
    }
    
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Range, DNT, X-CustomHeader, Keep-Alive, User-Agent, If-Modified-Since, Cache-Control, Pragma, Expires');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Max-Age', '3600');
    
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    } else {
        next();
    }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Para parsear application/x-www-form-urlencoded
app.use(express.static('public'));

// ========== SISTEMA DE GESTIÓN DE STREAMS ACTIVOS ==========
class ActiveStreamsManager {
    constructor() {
        this.activeStreams = new Set(); // Set de claves activas permitidas
        this.streamTimestamps = new Map(); // clave -> timestamp de inicio
        this.nginxStatsUrl = `http://${NGINX_LOCAL_STATS}/stats`; // Usar conexión local
    }

    // Agregar stream activo a la lista permitida
    addActiveStream(streamKey) {
        this.activeStreams.add(streamKey);
        this.streamTimestamps.set(streamKey, Date.now());
        console.log(`✅ Stream agregado a lista activa: ${streamKey}`);
        console.log(`📋 Streams activos: [${Array.from(this.activeStreams).join(', ')}]`);
    }

    // Remover stream de la lista activa
    removeActiveStream(streamKey) {
        this.activeStreams.delete(streamKey);
        this.streamTimestamps.delete(streamKey);
        console.log(`❌ Stream removido de lista activa: ${streamKey}`);
        console.log(`📋 Streams activos: [${Array.from(this.activeStreams).join(', ')}]`);
    }

    // Verificar si un stream está en la lista activa
    isStreamActive(streamKey) {
        return this.activeStreams.has(streamKey);
    }

    // Obtener todos los streams activos
    getActiveStreams() {
        return Array.from(this.activeStreams);
    }

    // Limpiar streams que no están conectados en nginx
    async cleanupInactiveStreams() {
        try {
            const nginxStreams = await this.getNginxActiveStreams();
            const activeStreamKeys = nginxStreams.map(s => s.name);

            // Remover streams de nuestra lista que ya no están en nginx
            for (const streamKey of this.activeStreams) {
                if (!activeStreamKeys.includes(streamKey)) {
                    console.log(`🧹 Limpiando stream inactivo: ${streamKey}`);
                    this.removeActiveStream(streamKey);
                }
            }
        } catch (error) {
            console.error('❌ Error limpiando streams inactivos:', error.message);
        }
    }

    // Obtener streams activos de nginx stats
    async getNginxActiveStreams() {
        try {
            const response = await fetch(this.nginxStatsUrl);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.text();
            // Parsear XML de nginx stats (simplificado)
            const streams = [];
            const streamMatches = data.match(/<client[^>]*>[\s\S]*?<\/client>/g);
            
            if (streamMatches) {
                streamMatches.forEach(match => {
                    const nameMatch = match.match(/<name>([^<]+)<\/name>/);
                    if (nameMatch) {
                        streams.push({ name: nameMatch[1] });
                    }
                });
            }

            return streams;
        } catch (error) {
            console.error('❌ Error obteniendo stats de nginx:', error.message);
            return [];
        }
    }

    // Desconectar stream no autorizado
    async dropUnauthorizedStream(streamKey) {
        try {
            console.log(`🔒 Desconectando stream no autorizado: ${streamKey}`);
            
            // En nginx-rtmp, podemos usar el endpoint de control si está habilitado
            // Como alternativa, podemos usar kill del proceso nginx o usar la API de control
            
            // Por ahora, solo lo removemos de nuestra lista
            this.removeActiveStream(streamKey);
            
            return { success: true };
        } catch (error) {
            console.error('❌ Error desconectando stream:', error.message);
            return { success: false, error: error.message };
        }
    }
}

// ========== CLASE STREAM SIMPLIFICADA (AHORA LOCAL CON NGINX HLS) ==========
class StreamInstance {
    constructor(userId, claveLocal, listaVideos = []) {
        this.userId = userId;
        this.claveLocal = claveLocal;
        this.listaVideos = listaVideos;
        this.isRunning = false;
        this.deviceConnected = false;
        this.hlsHealthInterval = null;
        this.monitoringInterval = null;
        this.lastNotification = {};
        this.notificationDebounceTime = 1000; // 1 segundo
        
        console.log(`📺 Stream creado para usuario ${userId} con key: ${claveLocal}`);
    }

    async start() {
        if (this.isRunning) {
            return { success: false, message: 'Stream ya está ejecutándose' };
        }

        try {
            console.log(`🚀 Iniciando stream ${this.claveLocal} para usuario ${this.userId}`);
            
            // Agregar a la lista de streams activos
            activeStreamsManager.addActiveStream(this.claveLocal);
            
            this.isRunning = true;
            
            // Notificar inmediatamente a los clientes que el stream está iniciando
            this._sendNotificationWithDebounce('streamStarted', {
                streamKey: this.claveLocal,
                message: 'Stream iniciado - videos de fallback activos',
                videosList: this.listaVideos,
                deviceConnected: false,
                rtmpAvailable: false,
                action: 'stream_started'
            });

            // Iniciar monitoreo
            await this._startMonitoring();
            
            console.log(`✅ Stream ${this.claveLocal} iniciado correctamente`);
            return { 
                success: true, 
                message: 'Stream iniciado correctamente',
                streamKey: this.claveLocal,
                videosCount: this.listaVideos.length
            };
            
        } catch (error) {
            console.error(`❌ Error iniciando stream ${this.claveLocal}:`, error);
            this.isRunning = false;
            activeStreamsManager.removeActiveStream(this.claveLocal);
            return { success: false, message: 'Error iniciando stream: ' + error.message };
        }
    }

    stop() {
        console.log(`🛑 Deteniendo stream ${this.claveLocal}`);
        
        this.isRunning = false;
        this.deviceConnected = false;
        
        // Limpiar intervalos
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = null;
        }
        
        if (this.hlsHealthInterval) {
            clearInterval(this.hlsHealthInterval);
            this.hlsHealthInterval = null;
        }
        
        // Remover de streams activos
        activeStreamsManager.removeActiveStream(this.claveLocal);
        
        // Notificar a los clientes que el stream se detuvo
        this._notifyStreamStopped();
        
        return { 
            success: true, 
            message: 'Stream detenido',
            streamKey: this.claveLocal // ✅ NUEVO: Retornar streamKey para notificaciones
        };
    }

    async _startMonitoring() {
        console.log(`� Iniciando monitoreo para stream ${this.claveLocal}`);
        
        // Monitoreo cada 5 segundos
        this.monitoringInterval = setInterval(async () => {
            try {
                await this._verifyNginxStream();
            } catch (error) {
                console.error(`Error en monitoreo de stream ${this.claveLocal}:`, error);
            }
        }, 5000);

        // Verificar salud del HLS cada 10 segundos
        this._startHLSHealthCheck();
    }

    _startHLSHealthCheck() {
        this.hlsHealthInterval = setInterval(async () => {
            if (this.deviceConnected) {
                const isHealthy = await this._checkHLSAvailability();
                if (!isHealthy) {
                    console.warn(`⚠️ HLS no saludable para stream ${this.claveLocal}`);
                    // El stream RTMP puede haberse desconectado sin notificar
                    this.deviceConnected = false;
                    this._notifyDeviceDisconnected();
                }
            }
        }, 10000);
    }

    async _checkHLSAvailability() {
        try {
            const hlsUrl = `http://localhost:8080/hls/${this.claveLocal}.m3u8`;
            const response = await fetch(hlsUrl, { 
                method: 'HEAD',
                timeout: 5000
            });
            return response.ok;
        } catch (error) {
            return false;
        }
    }

    _checkHLSHealth() {
        // Esta función puede expandirse para verificar la calidad del stream HLS
        return this._checkHLSAvailability();
    }

    async _verifyNginxStream() {
        try {
            // Verificar si el stream existe en nginx stats
            const response = await fetch(`http://${NGINX_LOCAL_STATS}/stats`, {
                timeout: 5000
            });
            
            if (!response.ok) {
                return;
            }

            const data = await response.text();
            const isStreamActive = data.includes(`<name>${this.claveLocal}</name>`);
            
            // Detectar cambios en el estado de conexión del dispositivo
            if (isStreamActive && !this.deviceConnected) {
                console.log(`📡 Dispositivo conectado para stream ${this.claveLocal}`);
                this.deviceConnected = true;
                this._notifyDeviceConnected();
            } else if (!isStreamActive && this.deviceConnected) {
                console.log(`📡 Dispositivo desconectado para stream ${this.claveLocal}`);
                this.deviceConnected = false;
                this._notifyDeviceDisconnected();
            }
            
        } catch (error) {
            console.error(`Error verificando nginx para stream ${this.claveLocal}:`, error);
        }
    }

    _notifyDeviceConnected() {
        console.log(`📢 Notificando dispositivo conectado: ${this.claveLocal}`);
        
        this._sendNotificationWithDebounce('deviceConnected', {
            streamKey: this.claveLocal,
            rtmpAvailable: true,
            deviceConnected: true,
            videosList: this.listaVideos,
            message: 'Dispositivo RTMP conectado'
        });
    }

    _notifyDeviceDisconnected() {
        console.log(`📢 Notificando dispositivo desconectado: ${this.claveLocal}`);
        
        this._sendNotificationWithDebounce('deviceDisconnected', {
            streamKey: this.claveLocal,
            rtmpAvailable: false,
            deviceConnected: false,
            videosList: this.listaVideos,
            message: 'Dispositivo RTMP desconectado - usando fallback'
        });
    }

    _notifyStreamStopped() {
        console.log(`📢 Notificando stream detenido: ${this.claveLocal}`);
        
        io.to(`stream_${this.claveLocal}`).emit('streamStopped', {
            streamKey: this.claveLocal,
            message: 'Stream detenido',
            action: 'stream_stopped'
        });

        // También notificar cambio de estado del dispositivo
        io.to(`stream_${this.claveLocal}`).emit('deviceStatusChange', {
            streamKey: this.claveLocal,
            rtmpAvailable: false,
            deviceConnected: false,
            message: 'Stream detenido'
        });
    }

    _sendNotificationWithDebounce(event, payload) {
        const now = Date.now();
        const lastTime = this.lastNotification[event] || 0;
        
        if (now - lastTime < this.notificationDebounceTime) {
            return; // Skip if too soon
        }
        
        this.lastNotification[event] = now;
        
        // Enviar a todos los clientes del stream
        io.to(`stream_${this.claveLocal}`).emit('deviceStatusChange', payload);
        
        // También enviar eventos específicos para mejor control
        switch (event) {
            case 'deviceConnected':
                io.to(`stream_${this.claveLocal}`).emit('rtmpConnected', {
                    streamKey: this.claveLocal,
                    message: payload.message,
                    rtmpAvailable: true,
                    action: 'rtmp_connected'
                });
                break;
            case 'deviceDisconnected':
                io.to(`stream_${this.claveLocal}`).emit('rtmpDisconnected', {
                    streamKey: this.claveLocal,
                    message: payload.message,
                    rtmpAvailable: false,
                    action: 'rtmp_disconnected'
                });
                break;
            case 'streamStarted':
                io.to(`stream_${this.claveLocal}`).emit('streamStarted', payload);
                break;
        }
        
        console.log(`� Enviado evento ${event} para stream ${this.claveLocal}`);
    }
}

// ========== MANAGER ==========
class StreamManager {
    constructor() {
        this.streams = {};
    }

    async start(id, claveLocal, listaVideos = []) {
        if (this.streams[id]) {
            const result = this.streams[id].stop();
            delete this.streams[id];
        }

        const stream = new StreamInstance(id, claveLocal, listaVideos);
        this.streams[id] = stream;

        const result = await stream.start();
        
        if (!result.success) {
            delete this.streams[id];
        }

        return result;
    }

    stop(id) {
        if (!this.streams[id]) {
            return { success: false, message: "Stream no encontrado" };
        }

        const result = this.streams[id].stop();
        delete this.streams[id];
        return result;
    }

    getStatus(id) {
        if (!this.streams[id]) {
            return { exists: false, streaming: false, connected: false };
        }

        const stream = this.streams[id];
        return {
            exists: true,
            streaming: stream.isRunning,
            connected: stream.deviceConnected,
            streamKey: stream.claveLocal,
            videosList: stream.listaVideos
        };
    }

    // Notificar a TODOS los clientes cuando el stream inicia
    notifyAllClientsStreamStarted(streamKey) {
        io.emit('streamStarted', {
            streamKey: streamKey,
            message: 'Stream iniciado',
            action: 'started'
        });
        
        // Notificar específicamente a clientes huérfanos
        orphanManager.notifyOrphansStreamStarted(streamKey);
    }
}

const manager = new StreamManager();
const activeStreamsManager = new ActiveStreamsManager();

// ========== SISTEMA DE LOGGING DE CONEXIONES ==========
const connectionLogs = [];
const MAX_LOG_ENTRIES = 1000; // Mantener solo las últimas 1000 entradas

function logConnectionEvent(event, status, details) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        event: event, // 'on_publish', 'on_publish_done', 'socket_connect', 'socket_disconnect'
        status: status, // 'ACCEPTED', 'REJECTED', 'DISCONNECTED', 'ERROR', 'CONNECTED'
        ...details
    };
    
    connectionLogs.push(logEntry);
    
    // Mantener solo las últimas entradas para evitar uso excesivo de memoria
    if (connectionLogs.length > MAX_LOG_ENTRIES) {
        connectionLogs.shift();
    }
    
    // Log mejorado en consola
    const emoji = getStatusEmoji(status);
    console.log(`${emoji} CONNECTION LOG [${event.toUpperCase()}] ${status}:`, JSON.stringify(details, null, 2));
}

function getStatusEmoji(status) {
    const emojis = {
        'ACCEPTED': '✅',
        'REJECTED': '❌',
        'DISCONNECTED': '🔌',
        'ERROR': '⚠️',
        'CONNECTED': '🟢'
    };
    return emojis[status] || '📝';
}

// Función para obtener clientes Socket.IO de un stream específico
function getSocketClientsForStream(streamKey) {
    const clients = [];
    const roomName = `stream_${streamKey}`;
    
    // Obtener todos los sockets en el room específico
    const room = io.sockets.adapter.rooms.get(roomName);
    if (room) {
        room.forEach(socketId => {
            const socket = io.sockets.sockets.get(socketId);
            if (socket) {
                clients.push({
                    id: socketId,
                    ip: socket.handshake.address || socket.conn.remoteAddress || 'unknown',
                    userAgent: socket.handshake.headers['user-agent'] || 'unknown',
                    connectedAt: socket.handshake.time || socket.conn.readyState,
                    streamKey: streamKey
                });
            }
        });
    }
    
    return clients;
}

// Función para obtener todos los clientes Socket.IO conectados
function getAllConnectedSockets() {
    const clients = [];
    
    io.sockets.sockets.forEach((socket, socketId) => {
        // Determinar a qué streams está conectado este socket
        const rooms = [];
        socket.rooms.forEach(room => {
            if (room.startsWith('stream_')) {
                rooms.push(room.replace('stream_', ''));
            }
        });
        
        clients.push({
            id: socketId,
            ip: socket.handshake.address || socket.conn.remoteAddress || 'unknown',
            userAgent: socket.handshake.headers['user-agent'] || 'unknown',
            connectedAt: new Date(socket.handshake.time).toISOString(),
            streams: rooms
        });
    });
    
    return clients;
}

// ========== ORPHAN CLIENTS MANAGER ==========
class OrphanClientsManager {
    constructor() {
        this.orphanClients = new Map(); // streamKey -> Set de socketIds
        this.clientLastSeen = new Map(); // socketId -> timestamp
        this.cleanupInterval = null;
    }

    startCleanupMonitor() {
        this.stopCleanupMonitor();
        
        this.cleanupInterval = setInterval(() => {
            this.cleanupDisconnectedClients();
        }, 30000); // Limpiar cada 30 segundos

        console.log('🔄 Monitor de limpieza de clientes huérfanos iniciado');
    }

    cleanupDisconnectedClients() {
        const now = Date.now();
        const timeoutMs = 60000; // 1 minuto sin heartbeat = desconectado

        for (const [socketId, lastSeen] of this.clientLastSeen.entries()) {
            if (now - lastSeen > timeoutMs) {
                console.log(`🧹 Limpiando cliente inactivo: ${socketId}`);
                this.removeClientFromAllStreams(socketId);
                this.clientLastSeen.delete(socketId);
            }
        }
    }

    addOrphanClient(streamKey, socketId) {
        if (!this.orphanClients.has(streamKey)) {
            this.orphanClients.set(streamKey, new Set());
        }
        this.orphanClients.get(streamKey).add(socketId);
        this.updateClientLastSeen(socketId);
        console.log(`👤 Cliente huérfano agregado: ${socketId} para stream: ${streamKey}`);
    }

    checkForOrphanedStreamKey(streamKey) {
        const hasOrphans = this.orphanClients.has(streamKey) && this.orphanClients.get(streamKey).size > 0;
        
        if (hasOrphans) {
            console.log(`👥 Stream ${streamKey} tiene clientes huérfanos esperando`);
            this.disconnectOrphanedStreamKey(streamKey);
        }

        return hasOrphans;
    }

    isStreamKeyActive(streamKey) {
        return activeStreamsManager.isStreamActive(streamKey);
    }

    async disconnectOrphanedStreamKey(streamKey) {
        if (!this.isStreamKeyActive(streamKey)) {
            console.log(`🔒 Desconectando streamKey huérfano: ${streamKey}`);
            
            const result = await activeStreamsManager.dropUnauthorizedStream(streamKey);
            
            if (result.success) {
                // Notificar a clientes que el stream no está autorizado
                this.notifyStreamStopped(streamKey);
            }

            return result;
        }
        
        return { success: false, message: "Stream está autorizado" };
    }

    removeOrphanClient(streamKey, socketId) {
        if (this.orphanClients.has(streamKey)) {
            this.orphanClients.get(streamKey).delete(socketId);
            
            if (this.orphanClients.get(streamKey).size === 0) {
                this.orphanClients.delete(streamKey);
            }
        }
        this.clientLastSeen.delete(socketId);
        console.log(`👤 Cliente huérfano removido: ${socketId} de stream: ${streamKey}`);
    }

    removeClientFromAllStreams(socketId) {
        for (const [streamKey, clients] of this.orphanClients.entries()) {
            clients.delete(socketId);
            if (clients.size === 0) {
                this.orphanClients.delete(streamKey);
            }
        }
        this.clientLastSeen.delete(socketId);
    }

    notifyOrphansStreamStarted(streamKey) {
        if (this.orphanClients.has(streamKey)) {
            const clients = this.orphanClients.get(streamKey);
            
            clients.forEach(socketId => {
                const socket = io.sockets.sockets.get(socketId);
                if (socket) {
                    socket.emit('streamStarted', {
                        streamKey: streamKey,
                        message: 'Stream iniciado - recargando automáticamente',
                        action: 'reload'
                    });
                    console.log(`🔄 Notificando inicio de stream a cliente huérfano: ${socketId}`);
                }
            });

            // Limpiar huérfanos ya que el stream está activo
            this.orphanClients.delete(streamKey);
        }
    }

    notifyStreamStopped(streamKey) {
        if (this.orphanClients.has(streamKey)) {
            const clients = this.orphanClients.get(streamKey);
            
            clients.forEach(socketId => {
                const socket = io.sockets.sockets.get(socketId);
                if (socket) {
                    socket.emit('waitingForStream', {
                        streamKey: streamKey,
                        message: 'Stream detenido - esperando reconexión',
                        status: 'waiting'
                    });
                }
            });
        }
    }

    updateClientLastSeen(socketId) {
        this.clientLastSeen.set(socketId, Date.now());
    }

    getOrphanStats() {
        const stats = {
            totalOrphanStreams: this.orphanClients.size,
            totalOrphanClients: 0,
            streams: {}
        };

        for (const [streamKey, clients] of this.orphanClients.entries()) {
            stats.totalOrphanClients += clients.size;
            stats.streams[streamKey] = clients.size;
        }

        return stats;
    }

    // Nuevo método para obtener clientes huérfanos de un stream específico
    getOrphanClients(streamKey) {
        if (this.orphanClients.has(streamKey)) {
            return Array.from(this.orphanClients.get(streamKey));
        }
        return [];
    }

    // Nuevo método para limpiar huérfanos de un stream específico
    clearOrphansForStream(streamKey) {
        if (this.orphanClients.has(streamKey)) {
            const clientCount = this.orphanClients.get(streamKey).size;
            this.orphanClients.delete(streamKey);
            console.log(`🧹 Limpiados ${clientCount} clientes huérfanos del stream: ${streamKey}`);
        }
    }

    stopCleanupMonitor() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
            console.log('🛑 Monitor de limpieza de clientes huérfanos detenido');
        }
    }
}

const orphanManager = new OrphanClientsManager();
orphanManager.startCleanupMonitor();

// ========== ENDPOINT ON_PUBLISH PARA NGINX (ULTRA OPTIMIZADO) ==========
app.post('/on_publish', (req, res) => {
    const streamKey = req.body.name;
    
    // ✅ RESPUESTA ULTRA-INMEDIATA - Solo verificación básica
    if (!streamKey) {
        res.status(400).send('Bad Request');
        return;
    }
    
    // ✅ VERIFICACIÓN ULTRA-RÁPIDA Y RESPUESTA INMEDIATA
    if (activeStreamsManager.isStreamActive(streamKey)) {
        // ✅ RESPONDER INMEDIATAMENTE SIN LOGS
        res.status(200).send('OK');
        
        // ✅ TODO EL PROCESAMIENTO PESADO EN BACKGROUND (no bloquea nginx)
        setImmediate(() => {
            // Log detallado para depuración: headers, body y IP
            try {
                const clientIP = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'] || 'unknown';
                const hdrs = safeStringify(req.headers);
                const bodyPreview = safeStringify(req.body);
                writeErrorLog(`[ON_PUBLISH_RECEIVED] Stream: ${streamKey} - IP: ${clientIP} - HEADERS: ${hdrs} - BODY: ${bodyPreview}`, null, 'DEBUG');
            } catch (err) {
                writeErrorLog('[ON_PUBLISH_RECEIVED] error stringifying request', err, 'ERROR');
            }

            const timestamp = new Date().toISOString();
            console.log(`✅ [${timestamp}] ON_PUBLISH - Stream ${streamKey} AUTORIZADO`);
            processOnPublishAsync(streamKey, req, timestamp);
        });
    } else {
        // ✅ RESPONDER INMEDIATAMENTE SIN LOGS
        res.status(403).send('Forbidden');
        
        // ✅ LOG ASÍNCRONO
        setImmediate(() => {
            const timestamp = new Date().toISOString();
            console.log(`❌ [${timestamp}] ON_PUBLISH - Stream ${streamKey} NO AUTORIZADO`);
            const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
            writeErrorLog(`[ON_PUBLISH_REJECTED] ${timestamp} - Stream: ${streamKey} - IP: ${clientIP} - NO AUTORIZADO`);
            // También guardar headers/body para conexiones rechazadas
            try {
                const hdrs = safeStringify(req.headers);
                const bodyPreview = safeStringify(req.body);
                writeErrorLog(`[ON_PUBLISH_REJECTED_DETAILS] Stream: ${streamKey} - HEADERS: ${hdrs} - BODY: ${bodyPreview}`, null, 'DEBUG');
            } catch (err) {
                writeErrorLog('[ON_PUBLISH_REJECTED] error stringifying request', err, 'ERROR');
            }
        });
    }
});

// ✅ FUNCIÓN ASÍNCRONA PARA PROCESAMIENTO PESADO (no bloquea nginx)
async function processOnPublishAsync(streamKey, req, timestamp) {
    try {
        const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
        
        // Log detallado (asíncrono)
        writeErrorLog(`[ON_PUBLISH_SUCCESS] ${timestamp} - Stream: ${streamKey} - IP: ${clientIP} - AUTORIZADO`);
        
        // Notificaciones Socket.IO (asíncrono)
        io.to(`stream_${streamKey}`).emit('rtmp_status_change', {
            streamKey: streamKey,
            rtmpStatus: 'ACTIVE',
            rtmpAvailable: true,
            deviceConnected: true,
            hlsUrl: `http://${NGINX_IP}:8080/hls/${streamKey}.m3u8`,
            timestamp: timestamp,
            message: 'RTMP conectado exitosamente',
            action: 'rtmp_started'
        });

        io.to(`stream_${streamKey}`).emit('rtmpConnected', {
            streamKey: streamKey,
            rtmpAvailable: true,
            hlsUrl: `http://${NGINX_IP}:8080/hls/${streamKey}.m3u8`
        });

        // Limpiar clientes huérfanos (asíncrono)
        orphanManager.clearOrphansForStream(streamKey);

        // Notificar al stream manager (asíncrono)
        const streamInstance = Object.values(manager.streams).find(s => s.claveLocal === streamKey);
        if (streamInstance) {
            streamInstance._notifyDeviceConnected();
        }
        
        console.log(`📢 [${timestamp}] Notificaciones enviadas para stream: ${streamKey}`);
    } catch (error) {
        console.error(`❌ Error en processOnPublishAsync:`, error);
    }
}

// ========== ENDPOINT ON_PUBLISH_DONE PARA NGINX (ULTRA OPTIMIZADO) ==========
app.post('/on_publish_done', (req, res) => {
    const streamKey = req.body.name;
    
    // ✅ RESPUESTA ULTRA-INMEDIATA
    if (!streamKey) {
        res.status(400).send('Bad Request');
        return;
    }
    
    // ✅ RESPONDER INMEDIATAMENTE
    res.status(200).send('OK');
    
    // ✅ TODO EL PROCESAMIENTO EN BACKGROUND (no bloquea nginx)
    setImmediate(() => {
        // Log detallado para depuración de desconexiones
        try {
            const clientIP = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'] || 'unknown';
            const hdrs = safeStringify(req.headers);
            const bodyPreview = safeStringify(req.body);
            writeErrorLog(`[ON_PUBLISH_DONE_RECEIVED] ${new Date().toISOString()} - Stream: ${streamKey} - IP: ${clientIP} - HEADERS: ${hdrs} - BODY: ${bodyPreview}`, null, 'DEBUG');
        } catch (err) {
            writeErrorLog('[ON_PUBLISH_DONE_RECEIVED] error stringifying request', err, 'ERROR');
        }

        const timestamp = new Date().toISOString();
        console.log(`🛑 [${timestamp}] ON_PUBLISH_DONE - Stream ${streamKey} RTMP desconectado`);
        processOnPublishDoneAsync(streamKey, req, timestamp);
    });
});

// ✅ FUNCIÓN ASÍNCRONA PARA PROCESAMIENTO PESADO (no bloquea nginx)
async function processOnPublishDoneAsync(streamKey, req, timestamp) {
    try {
        const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
        
        // Log detallado (asíncrono)
        writeErrorLog(`[ON_PUBLISH_DONE_SUCCESS] ${timestamp} - Stream: ${streamKey} - IP: ${clientIP} - DESCONECTADO`);
        
        // Notificaciones Socket.IO (asíncrono)
        io.to(`stream_${streamKey}`).emit('rtmp_status_change', {
            streamKey: streamKey,
            rtmpStatus: 'INACTIVE',
            rtmpAvailable: false,
            deviceConnected: false,
            timestamp: timestamp,
            message: 'RTMP desconectado - usando fallback',
            action: 'rtmp_stopped',
            fallbackActive: true
        });

        io.to(`stream_${streamKey}`).emit('rtmpDisconnected', {
            streamKey: streamKey,
            message: 'RTMP desconectado, cambiando a videos fallback',
            rtmpAvailable: false,
            fallbackActive: true,
            action: 'rtmp_disconnected'
        });

        // Notificar al stream manager (asíncrono)
        const streamInstance = Object.values(manager.streams).find(s => s.claveLocal === streamKey);
        if (streamInstance) {
            streamInstance._notifyDeviceDisconnected();
        }
        
        console.log(`📢 [${timestamp}] Notificaciones de desconexión enviadas para stream: ${streamKey}`);
    } catch (error) {
        console.error(`❌ Error en processOnPublishDoneAsync:`, error);
    }
}

// ========== API ENDPOINTS ==========

// Preparar stream (nuevo endpoint)
app.post('/api/stream/prepare', async (req, res) => {
    const { id, clave_local, lista_videos = [] } = req.body;

    if (!id || !clave_local) {
        return res.json({ 
            ok: false, 
            success: false, 
            message: 'Faltan parámetros requeridos: id y clave_local' 
        });
    }

    try {
        console.log(`🔧 Preparando stream para usuario ${id} con key: ${clave_local}`);
        
        // Agregar stream key a la lista de activos
        activeStreamsManager.addActiveStream(clave_local);
        
        // Notificar a los clientes que el stream está siendo preparado
        io.to(`stream_${clave_local}`).emit('streamPreparing', {
            streamKey: clave_local,
            message: 'Stream siendo preparado...',
            videosList: lista_videos,
            action: 'preparing'
        });

        // Notificar a clientes huérfanos
        orphanManager.notifyOrphansStreamStarted(clave_local);

        console.log(`✅ Stream ${clave_local} preparado correctamente`);

        res.json({ 
            ok: true, 
            success: true, 
            message: 'Stream preparado correctamente',
            streamKey: clave_local,
            videosCount: lista_videos.length
        });

    } catch (error) {
        writeErrorLog('Error preparando stream', error);
        res.json({ 
            ok: false, 
            success: false, 
            message: 'Error interno del servidor al preparar stream' 
        });
    }
});

// Iniciar stream
app.post('/api/stream/start', async (req, res) => {
    const { id, clave_local, señal, lista_videos = [] } = req.body;

    if (!id || !clave_local || señal !== 1) {
        return res.json({ 
            ok: false, 
            success: false, 
            message: 'Faltan parámetros requeridos o señal incorrecta' 
        });
    }

    try {
        console.log(`🚀 Iniciando stream para usuario ${id} con ${lista_videos.length} videos`);
        
        const result = await manager.start(String(id), clave_local, lista_videos);
        
        if (result.success) {
            // Notificar inmediatamente a todos los clientes conectados
            io.to(`stream_${clave_local}`).emit('streamStarted', {
                streamKey: clave_local,
                message: 'Stream iniciado exitosamente',
                videosList: lista_videos,
                action: 'started'
            });

            console.log(`✅ Stream ${clave_local} iniciado y clientes notificados`);
        }

        res.json({ ok: result.success, ...result });
    } catch (error) {
        writeErrorLog('Error iniciando stream', error);
        res.json({ 
            ok: false, 
            success: false, 
            message: 'Error interno del servidor' 
        });
    }
});

// Iniciar stream
// Detener stream
app.post('/api/stream/stop', (req, res) => {
    const { id, señal } = req.body;

    if (!id || señal !== 0) {
        return res.status(400).json({ 
            ok: false, 
            error: "Parámetros inválidos" 
        });
    }

    const result = manager.stop(String(id));
    
    // ✅ NUEVO: Notificar finalización completa del stream
    if (result.success && result.streamKey) {
        const timestamp = new Date().toISOString();
        
        console.log(`🛑 Stream completamente finalizado: ${result.streamKey}`);
        
        // Remover de streams activos
        activeStreamsManager.removeActiveStream(result.streamKey);
        
        // Notificar cambio de estado RTMP a STOPPED
        io.to(`stream_${result.streamKey}`).emit('rtmp_status_change', {
            streamKey: result.streamKey,
            rtmpStatus: 'STOPPED',
            rtmpAvailable: false,
            deviceConnected: false,
            timestamp: timestamp,
            message: 'Stream completamente finalizado',
            action: 'stream_stopped',
            fallbackActive: false
        });

        // Notificar finalización del stream
        io.to(`stream_${result.streamKey}`).emit('streamStopped', {
            streamKey: result.streamKey,
            message: 'Stream finalizado completamente',
            action: 'stream_stopped'
        });
        
        // Notificar al manager de huérfanos
        orphanManager.notifyStreamStopped(result.streamKey);
        
        console.log(`📢 Notificación de finalización enviada para stream: ${result.streamKey}`);
    }
    
    res.json({ ok: result.success, ...result });
});

// ✅ NUEVO: Endpoint para consultar estado RTMP de un stream específico
app.get('/api/stream/rtmp-status/:streamKey', async (req, res) => {
    const { streamKey } = req.params;

    if (!streamKey) {
        return res.status(400).json({ 
            ok: false, 
            error: "Stream key requerido" 
        });
    }

    try {
        // Verificar si el stream está en la lista activa
        const isActive = activeStreamsManager.isStreamActive(streamKey);
        
        // Verificar estado RTMP en nginx
        let rtmpActive = false;
        try {
            const nginxStreams = await activeStreamsManager.getNginxActiveStreams();
            rtmpActive = nginxStreams.some(stream => stream.name === streamKey);
        } catch (error) {
            console.log(`⚠️ No se pudo verificar estado RTMP en nginx: ${error.message}`);
        }

        // Obtener información del stream instance si existe
        const streamInstance = Object.values(manager.streams).find(s => s.claveLocal === streamKey);
        
        const status = {
            streamKey,
            isStreamActive: isActive,
            rtmpActive,
            rtmpAvailable: rtmpActive,
            deviceConnected: rtmpActive,
            streamInstanceExists: !!streamInstance,
            hlsUrl: `http://${NGINX_IP}:${NGINX_STATS_PORT}/hls/${streamKey}.m3u8`,
            timestamp: new Date().toISOString()
        };

        console.log(`📊 Estado RTMP consultado para ${streamKey}:`, status);

        res.json({ 
            ok: true, 
            ...status 
        });
    } catch (error) {
        writeErrorLog('Error en /api/stream/rtmp-status', error);
        res.status(500).json({ 
            ok: false, 
            error: error.message 
        });
    }
});

// Estado del stream
app.get('/api/stream/status/:id', (req, res) => {
    const { id } = req.params;

    if (!id) {
        return res.status(400).json({ 
            ok: false, 
            error: "ID requerido" 
        });
    }

    try {
        const status = manager.getStatus(String(id));
        res.json({ ok: true, ...status });
    } catch (error) {
        writeErrorLog('Error en /api/stream/status', error);
        res.status(500).json({ 
            ok: false, 
            error: error.message 
        });
    }
});

// Endpoint para obtener estado de conexiones activas
app.get('/api/streams/active', (req, res) => {
    try {
        const activeStreams = activeStreamsManager.getActiveStreams();
        res.json({ 
            ok: true, 
            activeStreams,
            count: activeStreams.length
        });
    } catch (error) {
        writeErrorLog('Error en /api/streams/active', error);
        res.status(500).json({ 
            ok: false, 
            error: error.message 
        });
    }
});

// Endpoint para obtener estadísticas de clientes huérfanos
app.get('/api/orphans/stats', (req, res) => {
    try {
        const stats = orphanManager.getOrphanStats();
        res.json({ ok: true, ...stats });
    } catch (error) {
        writeErrorLog('Error en /api/orphans/stats', error);
        res.status(500).json({ 
            ok: false, 
            error: error.message 
        });
    }
});

// ========== ENDPOINTS DE LOGS ==========

// Endpoint para ver logs de streaming
app.get('/api/logs/streaming', (req, res) => {
    const logPath = path.join(__dirname, 'streaming.log');
    
    try {
        if (fs.existsSync(logPath)) {
            const logs = fs.readFileSync(logPath, 'utf8');
            const lines = logs.split('\n').filter(line => line.trim());
            
            // Obtener solo las últimas 100 líneas
            const limit = parseInt(req.query.limit) || 100;
            const recentLines = lines.slice(-limit);
            
            res.json({ 
                ok: true, 
                logs: recentLines,
                total: lines.length,
                showing: recentLines.length,
                file: 'streaming.log'
            });
        } else {
            res.json({ 
                ok: true, 
                logs: [], 
                message: 'Log file not found',
                file: 'streaming.log'
            });
        }
    } catch (error) {
        res.status(500).json({ 
            ok: false, 
            error: error.message 
        });
    }
});

// Endpoint para ver logs de nginx hooks
app.get('/api/logs/nginx-hooks', (req, res) => {
    const logPath = path.join(__dirname, 'nginx-hooks.log');
    
    try {
        if (fs.existsSync(logPath)) {
            const logs = fs.readFileSync(logPath, 'utf8');
            const lines = logs.split('\n').filter(line => line.trim());
            
            // Obtener solo las últimas 50 líneas por defecto
            const limit = parseInt(req.query.limit) || 50;
            const recentLines = lines.slice(-limit);
            
            res.json({ 
                ok: true, 
                logs: recentLines,
                total: lines.length,
                showing: recentLines.length,
                file: 'nginx-hooks.log'
            });
        } else {
            res.json({ 
                ok: true, 
                logs: [], 
                message: 'Nginx hooks log file not found',
                file: 'nginx-hooks.log'
            });
        }
    } catch (error) {
        res.status(500).json({ 
            ok: false, 
            error: error.message 
        });
    }
});

// Endpoint para limpiar logs
app.post('/api/logs/clear', (req, res) => {
    const { file } = req.body;
    
    try {
        let logPath;
        if (file === 'streaming') {
            logPath = path.join(__dirname, 'streaming.log');
        } else if (file === 'nginx-hooks') {
            logPath = path.join(__dirname, 'nginx-hooks.log');
        } else {
            return res.status(400).json({ 
                ok: false, 
                error: 'Invalid file parameter. Use "streaming" or "nginx-hooks"' 
            });
        }
        
        if (fs.existsSync(logPath)) {
            fs.writeFileSync(logPath, '');
            writeErrorLog(`Log file cleared: ${file}.log`, null, 'INFO');
        }
        
        res.json({ 
            ok: true, 
            message: `Log file ${file}.log cleared successfully` 
        });
    } catch (error) {
        res.status(500).json({ 
            ok: false, 
            error: error.message 
        });
    }
});

// ========== VIEWER ROUTES ==========
app.get('/viewer/:streamKey', (req, res) => {
    const streamKey = req.params.streamKey;

    res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Stream Viewer - ${streamKey}</title>
        <style>
            body {
                margin: 0;
                padding: 20px;
                background: #000;
                color: #fff;
                font-family: Arial, sans-serif;
            }
            .container {
                max-width: 1200px;
                margin: 0 auto;
            }
            .video-container {
                position: relative;
                background: #111;
                border-radius: 8px;
                overflow: hidden;
            }
            video {
                width: 100%;
                height: auto;
            }
            .info {
                padding: 20px;
                background: #222;
                margin-top: 20px;
                border-radius: 8px;
            }
            .status {
                display: inline-block;
                padding: 5px 10px;
                border-radius: 4px;
                font-size: 14px;
                margin-right: 10px;
            }
            .status.active {
                background: #28a745;
            }
            .status.inactive {
                background: #dc3545;
            }
        </style>
        <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
    </head>
    <body>
        <div class="container">
            <h1>Stream: ${streamKey}</h1>
            <div class="video-container">
                <video id="video" controls muted autoplay></video>
            </div>
            <div class="info">
                <div id="status">
                    <span class="status inactive">Estado: Cargando...</span>
                </div>
                <p><strong>URL HLS:</strong> <span id="hlsUrl">http://${NGINX_IP}:${NGINX_STATS_PORT}/hls/${streamKey}.m3u8</span></p>
            </div>
        </div>

        <script>
            const video = document.getElementById('video');
            const statusEl = document.getElementById('status');
            const hlsUrl = 'http://${NGINX_IP}:${NGINX_STATS_PORT}/hls/${streamKey}.m3u8';

            function updateStatus(text, active = false) {
                statusEl.innerHTML = '<span class="status ' + (active ? 'active' : 'inactive') + '">Estado: ' + text + '</span>';
            }

            function setupHLS() {
                if (Hls.isSupported()) {
                    const hls = new Hls();
                    hls.loadSource(hlsUrl);
                    hls.attachMedia(video);
                    
                    hls.on(Hls.Events.MEDIA_ATTACHED, () => {
                        updateStatus('HLS cargado', true);
                    });
                    
                    hls.on(Hls.Events.ERROR, (event, data) => {
                        updateStatus('Error: ' + data.type);
                    });
                    
                    video.addEventListener('loadeddata', () => {
                        updateStatus('Stream activo', true);
                    });
                    
                } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                    video.src = hlsUrl;
                    updateStatus('Stream nativo activo', true);
                }
            }

            // Intentar cargar HLS
            setupHLS();

            // Verificar periódicamente si el stream está disponible
            setInterval(() => {
                fetch(hlsUrl, { method: 'HEAD' })
                    .then(response => {
                        if (response.ok) {
                            updateStatus('Stream disponible', true);
                        } else {
                            updateStatus('Stream no disponible');
                        }
                    })
                    .catch(() => {
                        updateStatus('Stream no disponible');
                    });
            }, 5000);
        </script>
    </body>
    </html>
    `);
});

// ========== RUTAS HLS DIRECTO DESDE FILESYSTEM ==========
app.get('/hls/:streamKey.m3u8', (req, res) => {
    const { streamKey } = req.params;
    const hlsPath = `/var/www/html/hls/${streamKey}.m3u8`;
    
    console.log(`🔍 Solicitando HLS: ${streamKey}.m3u8 desde ${req.get('Origin') || 'unknown'}`);
    
    // Configurar headers CORS explícitamente
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range,DNT,X-CustomHeader,Keep-Alive,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'false');
    res.setHeader('Access-Control-Max-Age', '3600');
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    // Leer directamente del filesystem
    fs.readFile(hlsPath, 'utf8', (err, data) => {
        if (err) {
            console.log(`❌ HLS file not found: ${hlsPath}`);
            if (!res.headersSent) {
                return res.status(404).send('HLS stream not found');
            }
            return;
        }
        
        console.log(`✅ Sirviendo HLS desde filesystem: ${streamKey}.m3u8`);
        if (!res.headersSent) {
            res.send(data);
        }
    });
});

// ========== RUTA PARA ARCHIVOS .TS (segmentos de video) ==========
app.get('/hls/:filename', (req, res) => {
    const { filename } = req.params;
    
    // Solo servir archivos .ts y .m3u8
    if (!filename.endsWith('.ts') && !filename.endsWith('.m3u8')) {
        return res.status(404).send('File type not allowed');
    }
    
    const filePath = `/var/www/html/hls/${filename}`;
    
    console.log(`🔍 Solicitando archivo: ${filename} desde ${req.get('Origin') || 'unknown'}`);
    
    // Configurar headers CORS explícitamente
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range,DNT,X-CustomHeader,Keep-Alive,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'false');
    res.setHeader('Access-Control-Max-Age', '3600');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    // Verificar que el archivo existe
    fs.access(filePath, fs.constants.F_OK, (err) => {
        if (err) {
            console.log(`❌ File not found: ${filePath}`);
            return res.status(404).send('File not found');
        }
        
        // Configurar headers apropiados según el tipo de archivo
        if (filename.endsWith('.ts')) {
            res.setHeader('Content-Type', 'video/mp2t');
        } else if (filename.endsWith('.m3u8')) {
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        }
        
        // Enviar archivo
        res.sendFile(filePath, (err) => {
            if (err) {
                console.error(`❌ Error sending file ${filename}:`, err);
                // Solo enviar respuesta si aún no se ha enviado
                if (!res.headersSent) {
                    res.status(500).send('Error serving file');
                }
            } else {
                console.log(`✅ Sirviendo desde filesystem: ${filename}`);
            }
        });
    });
});

// ========== SOCKET.IO EVENTS ==========
io.on('connection', (socket) => {
    console.log('🔌 Cliente conectado:', socket.id);

    // Manejar join a room de stream específico
    socket.on('join', (streamKey) => {
        socket.join(`stream_${streamKey}`);
        console.log(`👤 Cliente ${socket.id} unido a stream: ${streamKey}`);

        // Verificar si el stream está activo
        if (activeStreamsManager.isStreamActive(streamKey)) {
            // Encontrar el stream instance para obtener el estado real
            let streamInstance = null;
            let rtmpAvailable = false;
            let deviceConnected = false;
            let videosList = [];

            // Buscar la instancia del stream en el manager
            for (const [userId, stream] of Object.entries(manager.streams)) {
                if (stream.claveLocal === streamKey) {
                    streamInstance = stream;
                    rtmpAvailable = stream.deviceConnected || false;
                    deviceConnected = stream.deviceConnected || false;
                    videosList = stream.listaVideos || [];
                    break;
                }
            }

            // Convertir rutas de filesystem a URLs HTTP
            const videoUrls = videosList.map(videoPath => {
                return `${WEB_SERVER_URL}/${videoPath}`;
            });

            console.log(`📊 Estado real del stream ${streamKey}:`, {
                rtmpAvailable,
                deviceConnected,
                videosCount: videoUrls.length
            });

            socket.emit('streamActive', {
                streamKey: streamKey,
                streamActive: true,
                rtmpAvailable: rtmpAvailable,
                deviceConnected: deviceConnected,
                videosList: videoUrls,
                hlsUrl: `http://${NGINX_IP}:${NGINX_STATS_PORT}/hls/${streamKey}.m3u8`
            });
        } else {
            // Agregar como cliente huérfano
            orphanManager.addOrphanClient(streamKey, socket.id);
            socket.emit('waitingForStream', {
                streamKey: streamKey,
                message: 'Esperando que el stream se active...',
                status: 'waiting'
            });
        }
    });

    // Manejar solicitud de lista de videos
    socket.on('request_videos_list', (data) => {
        const { streamKey } = data;
        const clientId = socket.id;
        
        // Rate limiting: máximo 1 solicitud cada 5 segundos por cliente
        const now = Date.now();
        if (!socket.lastVideoRequest) socket.lastVideoRequest = 0;
        
        if (now - socket.lastVideoRequest < 5000) {
            console.log(`⚠️ Cliente ${clientId} ignorado por rate limiting (${Math.round((now - socket.lastVideoRequest) / 1000)}s desde última solicitud)`);
            return;
        }
        
        socket.lastVideoRequest = now;
        console.log(`📁 Cliente ${clientId} solicita videos para stream: ${streamKey}`);

        if (activeStreamsManager.isStreamActive(streamKey)) {
            // Buscar la instancia del stream
            for (const [userId, stream] of Object.entries(manager.streams)) {
                if (stream.claveLocal === streamKey) {
                    const videosList = stream.listaVideos || [];
                    console.log(`📁 Enviando ${videosList.length} videos para stream ${streamKey}`);
                    
                    // Convertir rutas de filesystem a URLs HTTP
                    const videoUrls = videosList.map(videoPath => {
                        // Convertir "storage/1/videos_de_corte/file.mp4" a URL HTTP
                        return `${WEB_SERVER_URL}/${videoPath}`;
                    });
                    
                    socket.emit('videos_list_response', {
                        streamKey: streamKey,
                        videosList: videoUrls
                    });
                    
                    // También emitir forzar reproducción local si no hay RTMP
                    if (!stream.deviceConnected && videoUrls.length > 0) {
                        console.log(`🎬 Forzando reproducción local para cliente ${clientId} (sin RTMP)`);
                        socket.emit('forceLocalPlayback', {
                            streamKey: streamKey,
                            videosList: videoUrls,
                            reason: 'No hay transmisión RTMP activa'
                        });
                    }
                    break;
                }
            }
        } else {
            console.log(`⚠️ Stream ${streamKey} no está activo, no se pueden enviar videos`);
            socket.emit('videos_list_response', {
                streamKey: streamKey,
                videosList: []
            });
        }
    });

    // Manejar verificación forzada de estado del stream
    socket.on('force_state_check', (data) => {
        const { streamKey } = data;
        const clientId = socket.id;
        
        console.log(`🔍 Cliente ${clientId} solicita verificación de estado para stream: ${streamKey}`);

        if (activeStreamsManager.isStreamActive(streamKey)) {
            // Buscar la instancia del stream
            for (const [userId, stream] of Object.entries(manager.streams)) {
                if (stream.claveLocal === streamKey) {
                    const videoUrls = (stream.listaVideos || []).map(videoPath => {
                        return `${WEB_SERVER_URL}/${videoPath}`;
                    });
                    
                    console.log(`📊 Estado verificado - RTMP: ${stream.deviceConnected}, Videos: ${videoUrls.length}`);
                    
                    socket.emit('streamActive', {
                        streamKey: streamKey,
                        streamActive: true,
                        rtmpAvailable: stream.deviceConnected || false,
                        deviceConnected: stream.deviceConnected || false,
                        videosList: videoUrls
                    });
                    break;
                }
            }
        } else {
            console.log(`⚠️ Stream ${streamKey} no activo en verificación de estado`);
            socket.emit('waitingForStream', {
                streamKey: streamKey,
                message: 'Stream no está activo',
                status: 'inactive'
            });
        }
    });

    // Manejar heartbeat para mantener vivo el cliente
    socket.on('heartbeat', () => {
        orphanManager.updateClientLastSeen(socket.id);
    });

    // Manejar desconexión
    socket.on('disconnect', () => {
        console.log('🔌 Cliente desconectado:', socket.id);
        orphanManager.removeClientFromAllStreams(socket.id);
    });
});

// Crear carpeta public si no existe
if (!fs.existsSync('public')) {
    fs.mkdirSync('public');
}

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 Cerrando servidor...');
    Object.keys(manager.streams).forEach(id => manager.stop(id));
    orphanManager.stopCleanupMonitor();
    server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
    console.log('🛑 Cerrando servidor...');
    Object.keys(manager.streams).forEach(id => manager.stop(id));
    orphanManager.stopCleanupMonitor();
    server.close(() => process.exit(0));
});

// Manejo global de errores no capturados
process.on('uncaughtException', (error) => {
    writeErrorLog('Uncaught Exception', error);
    console.error('❌ Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    writeErrorLog('Unhandled Promise Rejection', new Error(`Promise: ${promise}, Reason: ${reason}`));
    console.error('❌ Unhandled Promise Rejection:', reason);
});

// Iniciar servidor
const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Servidor iniciado en puerto ${PORT}`);
    console.log(`📺 Viewer: http://localhost:${PORT}/viewer/{clave_local}`);
    console.log(`🔧 API: http://localhost:${PORT}/api/stream/`);
    console.log(`📊 Streams activos: http://localhost:${PORT}/api/streams/active`);
    console.log(`👤 Orphans Stats: http://localhost:${PORT}/api/orphans/stats`);
    console.log(`📱 OBS URL: rtmp://${NGINX_IP}:${NGINX_RTMP_PORT}/live/{clave_local}`);
    console.log(`🎬 HLS URL: http://${NGINX_IP}:${NGINX_STATS_PORT}/hls/{clave_local}.m3u8`);
    console.log(`\n✅ Sistema listo con nginx HLS local:`);
    console.log(`   • Nginx genera HLS automáticamente`);
    console.log(`   • Control de streams autorizados vía on_publish`);
    console.log(`   • Detección automática de streams disponibles`);
    console.log(`   • Gestión de clientes huérfanos`);
    console.log(`   • API de control y estado\n`);
});

module.exports = { app, server };
