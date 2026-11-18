// Disable SSL certificate verification for self-signed certificates
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const net = require('net');
const crypto = require('crypto');
let createClient = null;
try {
    createClient = require('@libsql/client').createClient;
} catch (e) {
    // LibSQL client will load on Vercel environment
}

// Turso Database Credentials (Strictly from Vercel Environment Variables)
const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;

let turso = null;
try {
    if (TURSO_URL && TURSO_TOKEN) {
        turso = createClient({
            url: TURSO_URL,
            authToken: TURSO_TOKEN
        });
    }
} catch (e) {
    console.error('Turso Client Init Error:', e.message);
}

// Save or Update Customer in Turso Database (Dual-mode: LibSQL SDK or direct HTTP API)
async function saveToTurso(phone, mac) {
    if (!TURSO_URL || !TURSO_TOKEN) return;
    const cleanMac = (mac && !mac.startsWith('$') && mac.trim() !== '') ? mac.trim() : null;

    if (turso) {
        try {
            await turso.execute(`
                CREATE TABLE IF NOT EXISTS hotspot_users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    phone TEXT UNIQUE,
                    mac TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    last_login DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            await turso.execute({
                sql: `
                    INSERT INTO hotspot_users (phone, mac, created_at, last_login)
                    VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    ON CONFLICT(phone) DO UPDATE SET
                        last_login = CURRENT_TIMESTAMP,
                        mac = COALESCE(?, hotspot_users.mac)
                `,
                args: [phone, cleanMac, cleanMac]
            });

            console.log(`Turso DB: Successfully recorded customer ${phone}`);
            return;
        } catch (dbErr) {
            console.error('Turso SDK Error:', dbErr.message);
        }
    }

    // Direct HTTP Fallback
    try {
        const httpHost = TURSO_URL.replace('libsql://', 'https://');
        await fetch(`${httpHost}/v2/pipeline`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${TURSO_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                requests: [
                    { type: 'execute', stmt: { sql: `
                        CREATE TABLE IF NOT EXISTS hotspot_users (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            phone TEXT UNIQUE,
                            mac TEXT,
                            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                            last_login DATETIME DEFAULT CURRENT_TIMESTAMP
                        )
                    `}},
                    { type: 'execute', stmt: {
                        sql: `
                            INSERT INTO hotspot_users (phone, mac, created_at, last_login)
                            VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                            ON CONFLICT(phone) DO UPDATE SET
                                last_login = CURRENT_TIMESTAMP,
                                mac = COALESCE(?, hotspot_users.mac)
                        `,
                        args: [
                            { type: 'text', value: phone },
                            cleanMac ? { type: 'text', value: cleanMac } : { type: 'null' },
                            cleanMac ? { type: 'text', value: cleanMac } : { type: 'null' }
                        ]
                    }},
                    { type: 'close' }
                ]
            })
        });
        console.log(`Turso HTTP: Successfully recorded customer ${phone}`);
    } catch (httpErr) {
        console.error('Turso HTTP Error:', httpErr.message);
    }
}

// Generate deterministic 12-char password from phone + secret pepper
function generatePassword(phone, pepper) {
    return crypto.createHmac('sha256', pepper).update(phone).digest('hex').substring(0, 12);
}

// ============================================================
// Native MikroTik RouterOS API Client (Port 8728 - ROS 6.49 / 7)
// ============================================================
function encodeLength(len) {
    if (len < 0x80) return Buffer.from([len]);
    if (len < 0x4000) return Buffer.from([(len >> 8) | 0x80, len & 0xFF]);
    if (len < 0x200000) return Buffer.from([(len >> 16) | 0xC0, (len >> 8) & 0xFF, len & 0xFF]);
    return Buffer.from([(len >> 24) | 0xE0, (len >> 16) & 0xFF, (len >> 8) & 0xFF, len & 0xFF]);
}

function encodeWord(word) {
    const b = Buffer.from(word, 'utf8');
    return Buffer.concat([encodeLength(b.length), b]);
}

function sendSentence(socket, words) {
    const buffers = words.map(w => encodeWord(w));
    buffers.push(Buffer.from([0]));
    socket.write(Buffer.concat(buffers));
}

function parseSentences(buffer) {
    const sentences = [];
    let offset = 0;

    while (offset < buffer.length) {
        const words = [];
        let sentenceEnd = false;

        while (offset < buffer.length) {
            const b0 = buffer[offset];
            if (b0 === 0) {
                offset++;
                sentenceEnd = true;
                break;
            }

            let len = 0;
            let lenBytes = 0;

            if ((b0 & 0x80) === 0) {
                len = b0; lenBytes = 1;
            } else if ((b0 & 0xC0) === 0x80) {
                len = ((b0 & ~0x80) << 8) | buffer[offset + 1]; lenBytes = 2;
            } else if ((b0 & 0xE0) === 0xC0) {
                len = ((b0 & ~0xC0) << 16) | (buffer[offset + 1] << 8) | buffer[offset + 2]; lenBytes = 3;
            } else {
                len = ((b0 & ~0xE0) << 24) | (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3]; lenBytes = 4;
            }

            offset += lenBytes;
            if (offset + len > buffer.length) {
                return { sentences, remainingOffset: offset - lenBytes };
            }
            const word = buffer.slice(offset, offset + len).toString('utf8');
            words.push(word);
            offset += len;
        }

        if (sentenceEnd && words.length > 0) {
            sentences.push(words);
        }
    }

    return { sentences, remainingOffset: offset };
}

class RouterOSClient {
    constructor(host, port = 8728) {
        this.host = host;
        this.port = port;
        this.socket = null;
        this.buffer = Buffer.alloc(0);
    }

    async connect(user, password, timeout = 4000) {
        return new Promise((resolve, reject) => {
            this.socket = new net.Socket();
            this.socket.setTimeout(timeout);

            let state = 'login';

            this.socket.connect(this.port, this.host, () => {
                sendSentence(this.socket, [
                    '/login',
                    `=name=${user}`,
                    `=password=${password}`
                ]);
            });

            this.socket.on('data', (chunk) => {
                this.buffer = Buffer.concat([this.buffer, chunk]);
                const { sentences, remainingOffset } = parseSentences(this.buffer);

                for (const words of sentences) {
                    if (state === 'login') {
                        if (words[0] === '!done') {
                            state = 'ready';
                            this.buffer = this.buffer.slice(remainingOffset);
                            return resolve();
                        } else if (words[0] === '!trap') {
                            const msg = words.find(w => w.startsWith('=message=')) || words[1] || 'Auth failed';
                            this.socket.destroy();
                            return reject(new Error(msg));
                        }
                    }
                }

                this.buffer = this.buffer.slice(remainingOffset);
            });

            this.socket.on('error', (err) => reject(err));
            this.socket.on('timeout', () => {
                this.socket.destroy();
                reject(new Error('Connection timeout to MikroTik API'));
            });
        });
    }

    async command(words, timeout = 4000) {
        return new Promise((resolve, reject) => {
            const results = [];
            let timer = null;

            const onData = (chunk) => {
                this.buffer = Buffer.concat([this.buffer, chunk]);
                const { sentences, remainingOffset } = parseSentences(this.buffer);

                for (const sentence of sentences) {
                    const type = sentence[0];
                    if (type === '!re') {
                        const item = {};
                        for (let i = 1; i < sentence.length; i++) {
                            const w = sentence[i];
                            if (w.startsWith('=')) {
                                const eqIdx = w.indexOf('=', 1);
                                if (eqIdx !== -1) {
                                    const k = w.substring(1, eqIdx);
                                    const v = w.substring(eqIdx + 1);
                                    item[k] = v;
                                }
                            }
                        }
                        results.push(item);
                    } else if (type === '!done') {
                        cleanup();
                        resolve({ success: true, data: results });
                        return;
                    } else if (type === '!trap') {
                        cleanup();
                        const msg = sentence.find(w => w.startsWith('=message=')) || sentence[1] || 'Command failed';
                        resolve({ success: false, error: msg, data: results });
                        return;
                    }
                }

                this.buffer = this.buffer.slice(remainingOffset);
            };

            const cleanup = () => {
                if (timer) clearTimeout(timer);
                this.socket.removeListener('data', onData);
            };

            timer = setTimeout(() => {
                cleanup();
                reject(new Error('Command timeout on MikroTik'));
            }, timeout);

            this.socket.on('data', onData);
            sendSentence(this.socket, words);
        });
    }

    close() {
        if (this.socket) {
            try { this.socket.destroy(); } catch (e) {}
        }
    }
}

// Router Registration & Active Login Handler
async function handleRouterOS(host, port, user, pass, phone, password, clientIp, clientMac) {
    const client = new RouterOSClient(host, port);
    await client.connect(user, pass);

    let isNewUser = false;

    // 1. Check if user already exists
    const checkRes = await client.command(['/ip/hotspot/user/print', `?name=${phone}`]);
    const existingUsers = checkRes.data || [];

    if (existingUsers.length === 0) {
        isNewUser = true;
        // 2. Add new Hotspot User
        await client.command([
            '/ip/hotspot/user/add',
            `=name=${phone}`,
            `=password=${password}`,
            '=profile=guest-profile',
            `=comment=Self-reg | ${new Date().toLocaleDateString('en-GB')}`
        ]);
    } else {
        // If user has old MAC lock, clear it
        const u = existingUsers[0];
        if (u['mac-address'] && u['mac-address'] !== '') {
            await client.command([
                '/ip/hotspot/user/set',
                `=.id=${u['.id']}`,
                '=mac-address='
            ]);
        }
    }

    // 3. Direct Active Login (Immediate Internet Activation)
    let activated = false;
    let targetIp = null;

    if (clientIp && !clientIp.startsWith('$') && clientIp.trim() !== '') {
        targetIp = clientIp.trim();
    }

    if (!targetIp && clientMac && !clientMac.startsWith('$') && clientMac.trim() !== '') {
        const hostsRes = await client.command(['/ip/hotspot/host/print', `?mac-address=${clientMac.trim()}`]);
        const hosts = hostsRes.data || [];
        if (hosts.length > 0) {
            const validHost = hosts.find(h => h.address && h.address.startsWith('192.168.'))
                || hosts.find(h => h['to-address'] && h['to-address'].startsWith('192.168.'))
                || hosts[0];
            targetIp = (validHost.address && validHost.address.startsWith('192.168.')) ? validHost.address : (validHost['to-address'] || validHost.address);
        }
    }

    if (targetIp) {
        try {
            console.log(`Activating hotspot session for ${phone} on IP ${targetIp}...`);
            const actRes = await client.command([
                '/ip/hotspot/active/login',
                `=user=${phone}`,
                `=password=${password}`,
                `=ip=${targetIp}`
            ]);
            activated = actRes.success;
        } catch (actErr) {
            console.error('Active login error:', actErr.message);
        }
    }

    client.close();
    return { isNewUser, activated };
}

module.exports = async (req, res) => {
    // 1. CORS Headers
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Method Not Allowed' });
    }

    try {
        let body = req.body;
        if (typeof body === 'string') {
            try { body = JSON.parse(body); } catch (e) {}
        }
        const { phone, mac, ip } = body || {};

        // 2. Validate Bangladeshi 11-digit mobile number
        const bdMobileRegex = /^01[3-9]\d{8}$/;
        if (!phone || !bdMobileRegex.test(phone)) {
            return res.status(400).json({
                success: false,
                message: 'অনুগ্রহ করে সঠিক ১১ ডিজিটের মোবাইল নম্বর দিন (যেমন: 017XXXXXXXX)'
            });
        }

        // 3. Router Connection Info (Supports both Port 8728 binary API and HTTPS REST API)
        let ROUTER_HOST = process.env.ROUTER_HOST;
        let ROUTER_PORT = parseInt(process.env.ROUTER_PORT || '8728', 10);
        const ROUTER_URL = process.env.ROUTER_URL;

        if (!ROUTER_HOST && ROUTER_URL) {
            try {
                const u = new URL(ROUTER_URL);
                ROUTER_HOST = u.hostname;
                if (u.port && !process.env.ROUTER_PORT) {
                    ROUTER_PORT = parseInt(u.port, 10);
                }
            } catch (e) {}
        }

        // Default to CCR1036 Real IP 103.132.222.90 on Port 8728
        ROUTER_HOST = ROUTER_HOST || '103.132.222.90';
        ROUTER_PORT = 8728; // Standard MikroTik API port

        const API_USER = process.env.API_USER || 'api-hotspot';
        const API_PASS = process.env.API_PASS || 'Hotspot@1036Pass!';
        const SECRET_PEPPER = process.env.SECRET_PEPPER || 'HotspotSecretKey2025';

        const password = generatePassword(phone, SECRET_PEPPER);

        // 4. Record customer to Turso Database in background
        await saveToTurso(phone, mac);

        // 5. Connect directly to MikroTik RouterOS API on Port 8728
        console.log(`Connecting to MikroTik ${ROUTER_HOST}:${ROUTER_PORT} via API...`);
        const { isNewUser, activated } = await handleRouterOS(
            ROUTER_HOST,
            ROUTER_PORT,
            API_USER,
            API_PASS,
            phone,
            password,
            ip,
            mac
        );

        return res.status(200).json({
            success: true,
            activated: activated,
            status: isNewUser ? 'NEW_USER_CREATED' : 'EXISTING_USER',
            message: isNewUser ? 'রেজিস্ট্রেশন সফল হয়েছে! আপনি কানেক্টেড...' : 'স্বাগতম! আপনি কানেক্টেড...',
            username: phone,
            password: password
        });

    } catch (error) {
        console.error('Registration Error:', error);
        return res.status(500).json({
            success: false,
            message: 'সার্ভারের সাথে যোগাযোগ করা যাচ্ছে না।',
            error: error.message
        });
    }
};
