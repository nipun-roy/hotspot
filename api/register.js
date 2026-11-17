// Disable SSL certificate verification for MikroTik Real IP's self-signed SSL
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const crypto = require('crypto');

// Generate deterministic 12-char password from phone + secret pepper
function generatePassword(phone, pepper) {
    return crypto.createHmac('sha256', pepper).update(phone).digest('hex').substring(0, 12);
}

module.exports = async (req, res) => {
    // 1. CORS Headers
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

    // Handle preflight OPTIONS request
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Method Not Allowed' });
    }

    try {
        const { phone, mac } = req.body || {};

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
                message: 'Server configuration error: Environment variables (ROUTER_URL, API_USER, API_PASS) not configured on Vercel.'
            });
        }

        const password = generatePassword(phone, SECRET_PEPPER);
        const authHeader = 'Basic ' + Buffer.from(`${API_USER}:${API_PASS}`).toString('base64');

        // 4. Check if user already exists in MikroTik Hotspot database
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
                // User already exists, return credentials for instant login
                return res.status(200).json({
                    success: true,
                    status: 'EXISTING_USER',
                    message: 'স্বাগতম! আপনার অ্যাকাউন্ট পাওয়া গেছে, লগইন হচ্ছে...',
                    username: phone,
                    password: password
                });
            }
        }

        // 5. Create new Hotspot User in MikroTik
        const userPayload = {
            name: phone,
            password: password,
            profile: 'guest-profile',
            comment: `Self-reg Vercel | ${new Date().toLocaleDateString('en-GB')}`
        };

        if (mac && mac !== '$(mac)' && mac.trim() !== '') {
            userPayload['mac-address'] = mac.trim();
        }

        const createRes = await fetch(`${ROUTER_URL}/rest/ip/hotspot/user`, {
            method: 'PUT',
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(userPayload)
        });

        if (createRes.status === 201 || createRes.status === 200) {
            return res.status(200).json({
                success: true,
                status: 'NEW_USER_CREATED',
                message: 'রেজিস্ট্রেশন সফল হয়েছে! কানেক্ট করা হচ্ছে...',
                username: phone,
                password: password
            });
        } else {
            const errText = await createRes.text();
            console.error('MikroTik API Error:', errText);
            return res.status(500).json({
                success: false,
                message: 'MikroTik-এ ইউজার তৈরি করা যায়নি। অনুগ্রহ করে হেল্পডেস্কে যোগাযোগ করুন।'
            });
        }

    } catch (error) {
        console.error('Internal Server Error:', error);
        return res.status(500).json({
            success: false,
            message: 'সার্ভারের সাথে যোগাযোগ করা যাচ্ছে না। কিছুক্ষণ পর আবার চেষ্টা করুন।',
            error: error.message
        });
    }
};
