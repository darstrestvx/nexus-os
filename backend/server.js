#!/usr/bin/env node
/**
 * NEXUS OS — Backend Server v2.1.0
 * Node.js + Fastify + Docker SDK
 *
 * Estructura:
 *   GET  /api/apps              → listar apps instaladas
 *   GET  /api/apps/catalog      → catálogo disponible
 *   POST /api/apps/install      → instalar app
 *   POST /api/apps/:id/start    → iniciar contenedor
 *   POST /api/apps/:id/stop     → detener contenedor
 *   POST /api/apps/:id/remove   → eliminar app
 *   GET  /api/apps/:id/logs     → logs del contenedor
 *   GET  /api/system/metrics    → CPU, RAM, disco, red
 *   GET  /api/system/info       → info del servidor
 *   WS   /api/ws/metrics        → stream de métricas
 *   WS   /api/ws/logs           → stream de logs
 */

'use strict';

const fs          = require('fs');
const path        = require('path');
const os          = require('os');
const { exec, execSync } = require('child_process');
const { promisify } = require('util');
const execAsync   = promisify(exec);

// ── Configuración ─────────────────────────────────────────────────────────
const CONFIG = {
  port:         parseInt(process.env.NEXUS_API_PORT   || '8090'),
  host:         process.env.NEXUS_API_HOST             || '127.0.0.1',
  jwtSecret:    process.env.NEXUS_JWT_SECRET           || require('crypto').randomBytes(32).toString('hex'),
  catalogPath:  process.env.NEXUS_CATALOG_PATH         || path.join(__dirname, '../apps-catalog.json'),
  dataDir:      process.env.NEXUS_DATA_DIR             || '/var/lib/nexus',
  logDir:       process.env.NEXUS_LOG_DIR              || '/var/log/nexus-os',
  dockerSocket: process.env.DOCKER_SOCKET              || '/var/run/docker.sock',
  nexusBridge:  'nexus-bridge',
};

// ── Bootstrap de Fastify ──────────────────────────────────────────────────
let fastify;
try {
  fastify = require('fastify')({ logger: { level: 'warn' } });
} catch {
  console.error('[NEXUS] fastify no instalado. Ejecuta: npm install');
  process.exit(1);
}

// ── Plugins ───────────────────────────────────────────────────────────────
async function loadPlugins() {
  await fastify.register(require('@fastify/cors'), {
    origin: ['https://localhost:8443', 'http://localhost:8080'],
    credentials: true,
  });

  await fastify.register(require('@fastify/jwt'), {
    secret: CONFIG.jwtSecret,
    sign: { expiresIn: '8h' },
  });

  await fastify.register(require('@fastify/websocket'));

  await fastify.register(require('@fastify/rate-limit'), {
    max: 120,
    timeWindow: '1 minute',
  });

  // Archivos estáticos del frontend
  const frontendPath = path.join(__dirname, '../frontend');
  if (fs.existsSync(frontendPath)) {
    await fastify.register(require('@fastify/static'), {
      root: frontendPath,
      prefix: '/',
    });
  }
}

// ── Auth hook ─────────────────────────────────────────────────────────────
fastify.addHook('onRequest', async (req, reply) => {
  const open = ['/api/auth/login', '/api/health'];
  if (open.includes(req.url)) return;
  if (req.url.startsWith('/api/')) {
    try {
      await req.jwtVerify();
    } catch {
      reply.code(401).send({ error: 'No autorizado' });
    }
  }
});

// ── Helpers Docker ────────────────────────────────────────────────────────
async function docker(args) {
  const { stdout } = await execAsync(`docker ${args}`);
  return stdout.trim();
}

async function dockerJson(args) {
  const out = await docker(args);
  return out ? JSON.parse(out) : [];
}

async function containerExists(name) {
  try {
    await docker(`inspect ${name}`);
    return true;
  } catch { return false; }
}

async function containerStatus(name) {
  try {
    const out = await docker(`inspect --format "{{.State.Status}}" ${name}`);
    return out;
  } catch { return 'not_found'; }
}

// ── Helpers del sistema ───────────────────────────────────────────────────
function readProcStat() {
  const lines = fs.readFileSync('/proc/stat', 'utf8').split('\n');
  const cpu = lines[0].split(/\s+/).slice(1).map(Number);
  const idle = cpu[3] + cpu[4];
  const total = cpu.reduce((a, b) => a + b, 0);
  return { idle, total };
}

let _prevStat = readProcStat();
function getCpuPercent() {
  const cur = readProcStat();
  const dIdle  = cur.idle  - _prevStat.idle;
  const dTotal = cur.total - _prevStat.total;
  _prevStat = cur;
  if (dTotal === 0) return 0;
  return Math.round((1 - dIdle / dTotal) * 100);
}

function getMemInfo() {
  const raw = fs.readFileSync('/proc/meminfo', 'utf8');
  const get = (k) => parseInt(raw.match(new RegExp(`${k}:\\s+(\\d+)`))?.[1] || '0') * 1024;
  const total     = get('MemTotal');
  const available = get('MemAvailable');
  const used      = total - available;
  return {
    total, used, available,
    percent: Math.round((used / total) * 100),
  };
}

function getDiskInfo() {
  try {
    const out = execSync('df -B1 --output=source,size,used,avail,target 2>/dev/null').toString();
    return out.split('\n').slice(1)
      .filter(l => l.trim() && !l.includes('tmpfs') && !l.includes('udev'))
      .map(l => {
        const [source, size, used, avail, target] = l.trim().split(/\s+/);
        return {
          device: source, mountpoint: target,
          total: parseInt(size) || 0,
          used:  parseInt(used) || 0,
          free:  parseInt(avail) || 0,
          percent: Math.round((parseInt(used) / (parseInt(size) || 1)) * 100),
        };
      })
      .filter(d => d.total > 0);
  } catch { return []; }
}

function getNetStats() {
  try {
    const raw = fs.readFileSync('/proc/net/dev', 'utf8');
    return raw.split('\n').slice(2)
      .filter(l => l.trim() && !l.includes('lo:'))
      .map(l => {
        const parts = l.trim().split(/\s+/);
        const name  = parts[0].replace(':', '');
        return {
          interface: name,
          rx_bytes: parseInt(parts[1]) || 0,
          tx_bytes: parseInt(parts[9]) || 0,
        };
      })
      .filter(n => n.rx_bytes > 0 || n.tx_bytes > 0);
  } catch { return []; }
}

function getLoadAvg() {
  const raw = fs.readFileSync('/proc/loadavg', 'utf8').split(' ');
  return {
    '1m':  parseFloat(raw[0]),
    '5m':  parseFloat(raw[1]),
    '15m': parseFloat(raw[2]),
  };
}

function getUptime() {
  const secs = parseFloat(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return { seconds: Math.floor(secs), formatted: `${d}d ${h}h ${m}m` };
}

async function getDockerStats() {
  try {
    const raw = await docker('ps --format "{{json .}}"');
    if (!raw) return { running: 0, stopped: 0, containers: [] };
    const containers = raw.split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    return {
      running: containers.filter(c => c.State === 'running').length,
      stopped: containers.filter(c => c.State !== 'running').length,
      containers: containers.map(c => ({
        id: c.ID, name: c.Names, image: c.Image,
        state: c.State, status: c.Status, ports: c.Ports,
      })),
    };
  } catch { return { running: 0, stopped: 0, containers: [] }; }
}

// ── Catálogo de apps ──────────────────────────────────────────────────────
function loadCatalog() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG.catalogPath, 'utf8'));
  } catch {
    return { apps: [], categories: [] };
  }
}

function getAppById(id) {
  const { apps } = loadCatalog();
  return apps.find(a => a.id === id) || null;
}

// Estado persistente de apps instaladas
const INSTALLED_FILE = path.join(CONFIG.dataDir, 'installed-apps.json');
function loadInstalled() {
  try { return JSON.parse(fs.readFileSync(INSTALLED_FILE, 'utf8')); }
  catch { return {}; }
}
function saveInstalled(data) {
  fs.mkdirSync(CONFIG.dataDir, { recursive: true });
  fs.writeFileSync(INSTALLED_FILE, JSON.stringify(data, null, 2));
}

// ── Generador de docker-compose ───────────────────────────────────────────
function generateComposeFile(appDef, userConfig = {}) {
  const compose = JSON.parse(JSON.stringify(appDef.compose));
  const appDataDir = path.join(CONFIG.dataDir, 'apps', appDef.id);
  fs.mkdirSync(appDataDir, { recursive: true });

  // Reemplazar variables de entorno con valores del usuario
  const service = Object.values(compose.services)[0];
  if (service.environment) {
    for (const [k, v] of Object.entries(service.environment)) {
      if (typeof v === 'string' && v.startsWith('${')) {
        const varName = v.replace(/\$\{(.+?)\}/, '$1').split(':-')[0];
        const defVal  = v.replace(/\$\{(.+?)\}/, '$1').split(':-')[1] || '';
        service.environment[k] = userConfig[varName] || defVal || `nexus_${Math.random().toString(36).slice(2,10)}`;
      }
    }
  }

  // Reemplazar rutas de volúmenes
  if (service.volumes) {
    service.volumes = service.volumes.map(v => {
      if (typeof v === 'string') {
        return v.replace(/\$\{[^}]+:-([^}]+)\}/, '$1');
      }
      return v;
    });
  }

  // Asegurar que usa la red nexus-bridge (salvo network_mode: host)
  if (!service.network_mode) {
    compose.networks = { 'nexus-bridge': { external: true } };
    service.networks = ['nexus-bridge'];
  }

  return compose;
}

// ── RUTAS ─────────────────────────────────────────────────────────────────

// Health
fastify.get('/api/health', async () => ({
  status: 'ok', version: '2.1.0', ts: Date.now(),
}));

// Auth: login
fastify.post('/api/auth/login', {
  schema: {
    body: {
      type: 'object',
      required: ['password'],
      properties: {
        username: { type: 'string' },
        password: { type: 'string' },
      },
    },
  },
}, async (req, reply) => {
  const { username = 'admin', password } = req.body;

  // En producción: verificar contra hash Argon2 en DB
  // Aquí usamos la variable de entorno NEXUS_ADMIN_TOKEN como contraseña
  const validPass = process.env.NEXUS_ADMIN_TOKEN || process.env.NEXUS_DEFAULT_PASS || 'changeme123';

  if (password !== validPass) {
    // Log de intento fallido para fail2ban
    const logLine = `[WARN] Failed login attempt from ${req.ip} user=${username}\n`;
    fs.appendFileSync(path.join(CONFIG.logDir, 'access.log'), logLine);
    return reply.code(401).send({ error: 'Credenciales incorrectas' });
  }

  const token = fastify.jwt.sign({ username, role: 'admin' });
  const logLine = `[OK] Login exitoso from ${req.ip} user=${username}\n`;
  fs.appendFileSync(path.join(CONFIG.logDir, 'access.log'), logLine);
  return { token, username, role: 'admin', expiresIn: 28800 };
});

// System: métricas
fastify.get('/api/system/metrics', async () => {
  const [mem, docker] = await Promise.all([
    Promise.resolve(getMemInfo()),
    getDockerStats(),
  ]);
  return {
    cpu:    { percent: getCpuPercent(), cores: os.cpus().length, loadAvg: getLoadAvg() },
    memory: mem,
    disks:  getDiskInfo(),
    network: getNetStats(),
    docker,
    uptime: getUptime(),
    ts: Date.now(),
  };
});

// System: info del servidor
fastify.get('/api/system/info', async () => {
  let osRelease = {};
  try {
    const raw = fs.readFileSync('/etc/os-release', 'utf8');
    raw.split('\n').forEach(l => {
      const [k, v] = l.split('=');
      if (k && v) osRelease[k] = v.replace(/"/g, '');
    });
  } catch {}

  return {
    hostname:     os.hostname(),
    platform:     os.platform(),
    arch:         os.arch(),
    kernel:       os.release(),
    os:           osRelease.PRETTY_NAME || 'Linux',
    cpuModel:     os.cpus()[0]?.model || 'Unknown',
    cpuCores:     os.cpus().length,
    totalMemory:  os.totalmem(),
    uptime:       getUptime(),
    nexusVersion: '2.1.0',
    nodeVersion:  process.version,
  };
});

// Apps: catálogo disponible
fastify.get('/api/apps/catalog', async (req) => {
  const catalog = loadCatalog();
  const installed = loadInstalled();
  const { category, search, sort } = req.query;

  let apps = catalog.apps.map(app => ({
    ...app,
    installed: !!installed[app.id],
    installedStatus: installed[app.id]?.status || null,
  }));

  if (category) apps = apps.filter(a => a.category === category);
  if (search) {
    const q = search.toLowerCase();
    apps = apps.filter(a =>
      a.name.toLowerCase().includes(q) ||
      a.tagline.toLowerCase().includes(q) ||
      a.tags?.some(t => t.includes(q))
    );
  }
  if (sort === 'name') apps.sort((a, b) => a.name.localeCompare(b.name));

  return {
    categories: catalog.categories,
    apps,
    total: apps.length,
  };
});

// Apps: instaladas (con estado real de Docker)
fastify.get('/api/apps', async () => {
  const installed = loadInstalled();
  const result = [];

  for (const [id, meta] of Object.entries(installed)) {
    const status = await containerStatus(meta.containerName || id);
    result.push({
      id,
      name:          meta.name,
      image:         meta.image,
      port:          meta.port,
      portLabel:     meta.portLabel,
      containerName: meta.containerName,
      installedAt:   meta.installedAt,
      status,
      icon:          meta.icon,
      color:         meta.color,
    });
  }

  return { apps: result, total: result.length };
});

// Apps: instalar
fastify.post('/api/apps/install', {
  schema: {
    body: {
      type: 'object',
      required: ['appId'],
      properties: {
        appId:      { type: 'string' },
        userConfig: { type: 'object' },
      },
    },
  },
}, async (req, reply) => {
  const { appId, userConfig = {} } = req.body;
  const appDef = getAppById(appId);

  if (!appDef) {
    return reply.code(404).send({ error: `App '${appId}' no encontrada en el catálogo` });
  }

  const installed = loadInstalled();
  if (installed[appId]) {
    return reply.code(409).send({ error: `'${appDef.name}' ya está instalada` });
  }

  // Generar compose
  const compose    = generateComposeFile(appDef, userConfig);
  const appDataDir = path.join(CONFIG.dataDir, 'apps', appId);
  const composeFile = path.join(appDataDir, 'docker-compose.yml');

  // Serializar YAML manualmente (evitar dependencia de yaml lib)
  fs.writeFileSync(composeFile, toYaml({ version: '3.8', ...compose }));

  // Ejecutar docker compose up
  const { stdout, stderr } = await execAsync(
    `docker compose -f "${composeFile}" up -d --pull always`,
    { timeout: 120000 }
  );

  const containerName = Object.keys(compose.services)[0];
  const status = await containerStatus(containerName);

  installed[appId] = {
    id:            appId,
    name:          appDef.name,
    image:         appDef.image,
    port:          appDef.port,
    portLabel:     appDef.portLabel,
    containerName,
    composeFile,
    icon:          appDef.icon,
    color:         appDef.color,
    installedAt:   new Date().toISOString(),
    status,
  };
  saveInstalled(installed);

  // Log
  const logLine = `[OK] App instalada: ${appDef.name} (${appId}) by ${req.user.username}\n`;
  fs.appendFileSync(path.join(CONFIG.logDir, 'nexus.log'), logLine);

  return {
    success: true,
    app: installed[appId],
    output: stdout.slice(0, 500),
  };
});

// Apps: start
fastify.post('/api/apps/:id/start', async (req, reply) => {
  const { id } = req.params;
  const installed = loadInstalled();
  if (!installed[id]) return reply.code(404).send({ error: 'App no instalada' });
  await docker(`start ${installed[id].containerName}`);
  installed[id].status = 'running';
  saveInstalled(installed);
  return { success: true, status: 'running' };
});

// Apps: stop
fastify.post('/api/apps/:id/stop', async (req, reply) => {
  const { id } = req.params;
  const installed = loadInstalled();
  if (!installed[id]) return reply.code(404).send({ error: 'App no instalada' });
  await docker(`stop ${installed[id].containerName}`);
  installed[id].status = 'exited';
  saveInstalled(installed);
  return { success: true, status: 'exited' };
});

// Apps: remove
fastify.delete('/api/apps/:id', async (req, reply) => {
  const { id } = req.params;
  const { removeData = false } = req.query;
  const installed = loadInstalled();
  if (!installed[id]) return reply.code(404).send({ error: 'App no instalada' });

  const { composeFile, containerName, name } = installed[id];

  // Bajar y eliminar contenedor
  if (fs.existsSync(composeFile)) {
    await execAsync(`docker compose -f "${composeFile}" down ${removeData ? '-v' : ''}`).catch(() => {});
  } else {
    await docker(`rm -f ${containerName}`).catch(() => {});
  }

  if (removeData) {
    fs.rmSync(path.join(CONFIG.dataDir, 'apps', id), { recursive: true, force: true });
  }

  delete installed[id];
  saveInstalled(installed);

  const logLine = `[WARN] App eliminada: ${name} (${id}) by ${req.user.username} removeData=${removeData}\n`;
  fs.appendFileSync(path.join(CONFIG.logDir, 'nexus.log'), logLine);

  return { success: true };
});

// Apps: logs del contenedor
fastify.get('/api/apps/:id/logs', async (req, reply) => {
  const { id } = req.params;
  const { lines = 100 } = req.query;
  const installed = loadInstalled();
  if (!installed[id]) return reply.code(404).send({ error: 'App no instalada' });
  try {
    const logs = await docker(`logs --tail ${lines} ${installed[id].containerName}`);
    return { logs: logs.split('\n'), lines: parseInt(lines) };
  } catch (e) {
    return { logs: [], error: e.message };
  }
});

// Docker: contenedores raw
fastify.get('/api/docker/containers', async () => {
  const out = await docker('ps -a --format "{{json .}}"');
  if (!out) return { containers: [] };
  const containers = out.split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  return { containers };
});

// Docker: limpiar recursos no usados
fastify.post('/api/docker/prune', async () => {
  const { stdout } = await execAsync('docker system prune -f 2>&1');
  return { success: true, output: stdout.slice(0, 500) };
});

// ── WebSocket: métricas en tiempo real ────────────────────────────────────
fastify.get('/api/ws/metrics', { websocket: true }, (socket) => {
  let interval;
  socket.on('error', () => clearInterval(interval));
  socket.on('close', () => clearInterval(interval));

  interval = setInterval(async () => {
    if (socket.readyState !== 1) { clearInterval(interval); return; }
    try {
      const metrics = {
        cpu:     { percent: getCpuPercent(), loadAvg: getLoadAvg() },
        memory:  getMemInfo(),
        network: getNetStats(),
        uptime:  getUptime(),
        ts:      Date.now(),
      };
      socket.send(JSON.stringify(metrics));
    } catch { clearInterval(interval); }
  }, 2000);
});

// ── WebSocket: logs en tiempo real ────────────────────────────────────────
fastify.get('/api/ws/logs', { websocket: true }, (socket) => {
  const logFile = path.join(CONFIG.logDir, 'nexus.log');
  fs.mkdirSync(CONFIG.logDir, { recursive: true });
  if (!fs.existsSync(logFile)) fs.writeFileSync(logFile, '');

  const tail = require('child_process').spawn('tail', ['-f', logFile]);
  tail.stdout.on('data', (data) => {
    if (socket.readyState === 1) socket.send(data.toString());
  });
  socket.on('close', () => tail.kill());
  socket.on('error', () => tail.kill());
});

// ── Utilidad: serializar a YAML básico ────────────────────────────────────
function toYaml(obj, indent = 0) {
  const pad = '  '.repeat(indent);
  let out = '';
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      out += `${pad}${k}:\n`;
      v.forEach(item => {
        if (typeof item === 'object') {
          out += `${pad}  -\n${toYaml(item, indent + 2)}`;
        } else {
          out += `${pad}  - ${item}\n`;
        }
      });
    } else if (typeof v === 'object') {
      out += `${pad}${k}:\n${toYaml(v, indent + 1)}`;
    } else {
      const val = typeof v === 'string' && v.includes(':') ? `"${v}"` : v;
      out += `${pad}${k}: ${val}\n`;
    }
  }
  return out;
}

// ── Error handler ─────────────────────────────────────────────────────────
fastify.setErrorHandler((err, req, reply) => {
  const status = err.statusCode || 500;
  if (status === 500) {
    const logLine = `[ERROR] ${req.method} ${req.url} — ${err.message}\n`;
    fs.appendFileSync(path.join(CONFIG.logDir, 'nexus.log'), logLine);
  }
  reply.code(status).send({
    error:   err.message || 'Error interno',
    code:    err.code || 'INTERNAL_ERROR',
    status,
  });
});

// ── Startup ───────────────────────────────────────────────────────────────
async function start() {
  try {
    await loadPlugins();
    await fastify.listen({ port: CONFIG.port, host: CONFIG.host });

    fs.mkdirSync(CONFIG.logDir, { recursive: true });
    const logLine = `[OK] NEXUS OS Backend iniciado en ${CONFIG.host}:${CONFIG.port}\n`;
    fs.appendFileSync(path.join(CONFIG.logDir, 'nexus.log'), logLine);
    console.log(`[NEXUS OS] Backend activo → http://${CONFIG.host}:${CONFIG.port}`);
    console.log(`[NEXUS OS] Catálogo:  ${CONFIG.catalogPath}`);
    console.log(`[NEXUS OS] Datos:     ${CONFIG.dataDir}`);
  } catch (err) {
    console.error('[NEXUS OS] Error al iniciar:', err.message);
    process.exit(1);
  }
}

start();
