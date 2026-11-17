// Disable SSL certificate verification for MikroTik Real IP's self-signed SSL
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const crypto = require('crypto');
const { createClient } = require('@libsql/client');

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

// Save or Update Customer in Turso Database
async function saveToTurso(phone, mac) {
    if (!turso) return;
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

        const cleanMac = (mac && !mac.startsWith('$') && mac.trim() !== '') ? mac.trim() : null;

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
    } catch (dbErr) {
        console.error('Turso DB Error:', dbErr.message);
    }
}

// Generate deterministic 12-char password from phone + secret pepper
function generatePassword(phone, pepper) {
    return crypto.createHmac('sha256', pepper).update(phone).digest('hex').substring(0, 12);
}

// Direct Server-Side Hotspot Activation on MikroTik
async function activateUserOnRouter(ROUTER_URL, authHeader, phone, password, clientIp, clientMac) {
    try {
        let targetIp = null;
        if (clientIp && !clientIp.startsWith('$') && clientIp.trim() !== '') {
            targetIp = clientIp.trim();
        }

        // If IP is not directly known, look up the host by MAC address on MikroTik
        if (!targetIp && clientMac && !clientMac.startsWith('$') && clientMac.trim() !== '') {
            const hostsRes = await fetch(`${ROUTER_URL}/rest/ip/hotspot/host?mac-address=${encodeURIComponent(clientMac.trim())}`, {
                headers: { 'Authorization': authHeader }
            });
            if (hostsRes.ok) {
                const hosts = await hostsRes.json();
                if (hosts && hosts.length > 0) {
                    targetIp = hosts[0].address;
                }
            }
        }

        if (targetIp) {
            console.log(`Activating hotspot user ${phone} on target IP ${targetIp}...`);
            const actRes = await fetch(`${ROUTER_URL}/rest/ip/hotspot/active/login`, {
                method: 'POST',
                headers: {
                    'Authorization': authHeader,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    user: phone,
                    password: password,
                    ip: targetIp
                })
            });
            console.log(`Active login result for ${phone} (${targetIp}): status ${actRes.status}`);
            return actRes.ok;
        } else {
            console.log(`No target IP found for active login of ${phone}`);
        }
    } catch (actErr) {
        console.error('Active login error:', actErr.message);
    }
    return false;
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
            try {
                body = JSON.parse(body);
            } catch (e) {}
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

        // 3. Environment Variables
        const ROUTER_URL = process.env.ROUTER_URL;
        const API_USER = process.env.API_USER;
        const API_PASS = process.env.API_PASS;
        const SECRET_PEPPER = process.env.SECRET_PEPPER || 'HotspotSecretKey2025';

        if (!ROUTER_URL || !API_USER || !API_PASS) {
            return res.status(500).json({
                success: false,
                message: 'Server configuration error: MikroTik Environment variables not set.'
            });
        }

        const password = generatePassword(phone, SECRET_PEPPER);
        const authHeader = 'Basic ' + Buffer.from(`${API_USER}:${API_PASS}`).toString('base64');

        // 4. Record to Turso Database in background
        await saveToTurso(phone, mac);

        // 5. Check if user already exists in MikroTik Hotspot
        const checkUrl = `${ROUTER_URL}/rest/ip/hotspot/user?name=${phone}`;
        const checkRes = await fetch(checkUrl, {
            method: 'GET',
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/json'
            }
        });

        if (checkRes.ok) {
            const users = await checkRes.json();
            if (users && users.length > 0) {
                const existingUser = users[0];

                // If user had an old MAC address bound, clear it so they can switch phones freely
                if (existingUser['mac-address'] && existingUser['mac-address'] !== '') {
                    try {
                        await fetch(`${ROUTER_URL}/rest/ip/hotspot/user/${existingUser['.id']}`, {
                            method: 'PATCH',
                            headers: {
                                'Authorization': authHeader,
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({ 'mac-address': '' })
                        });
                    } catch (patchErr) {
                        console.error('MAC clear error:', patchErr.message);
                    }
                }

                // Directly activate the session on MikroTik
                const activated = await activateUserOnRouter(ROUTER_URL, authHeader, phone, password, ip, mac);

                return res.status(200).json({
                    success: true,
                    activated: activated,
                    status: 'EXISTING_USER',
                    message: 'স্বাগতম! আপনি কানেক্টেড...',
                    username: phone,
                    password: password
                });
            }
        }

        // 6. Create new Hotspot User in MikroTik
        // NOTE: We deliberately do NOT bind 'mac-address' here so the customer can use any phone/device or randomized MAC
        const userPayload = {
            name: phone,
            password: password,
            profile: 'guest-profile',
            comment: `Self-reg | ${new Date().toLocaleDateString('en-GB')}`
        };

        const createRes = await fetch(`${ROUTER_URL}/rest/ip/hotspot/user`, {
            method: 'PUT',
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(userPayload)
        });

        if (createRes.status === 201 || createRes.status === 200) {
            // Directly activate the session on MikroTik
            const activated = await activateUserOnRouter(ROUTER_URL, authHeader, phone, password, ip, mac);

            return res.status(200).json({
                success: true,
                activated: activated,
                status: 'NEW_USER_CREATED',
                message: 'রেজিস্ট্রেশন সফল হয়েছে! আপনি কানেক্টেড...',
                username: phone,
                password: password
            });
        } else {
            const errText = await createRes.text();
            console.error('MikroTik API Error:', errText);
            return res.status(500).json({
                success: false,
                message: 'MikroTik-এ ইউজার তৈরি করা যায়নি।'
            });
        }

    } catch (error) {
        console.error('Internal Server Error:', error);
        return res.status(500).json({
            success: false,
            message: 'সার্ভারের সাথে যোগাযোগ করা যাচ্ছে না।',
            error: error.message
        });
    }
};
