# MikroTik Hotspot Mobile Number Registration System (Vercel Serverless)

এই প্রজেক্টটি একটি সার্ভারলেস ব্যাকএন্ড API যা MikroTik Hotspot-এ কাস্টমারদের মোবাইল নম্বর দিয়ে স্বয়ংক্রিয় রেজিস্ট্রেশন এবং লগইন সম্পন্ন করায়।

---

## 🚀 আর্কিটেকচার

1. কাস্টমার হটস্পট ওয়াইফাই কানেক্ট করলে `hotspot/login.html` পেজটি ওপেন হবে।
2. কাস্টমার তার ১১ ডিজিটের মোবাইল নম্বর ইনপুট দিয়ে কানেক্ট করবে।
3. ব্রাউজার থেকে Vercel Serverless API (`/api/register`) এ কল যাবে।
4. Vercel সরাসরি আপনার MikroTik-এর REST API (`https://103.132.220.121:8443`) কল করে ইউজার তৈরি করবে।
5. স্বয়ংক্রিয়ভাবে পাসওয়ার্ড পেয়ে কাস্টমার ইন্টারনেটে কানেক্ট হয়ে যাবে।

---

## 🛠️ Vercel Environment Variables

Vercel ড্যাশবোর্ডে গিয়ে প্রজেক্টের **Settings -> Environment Variables**-এ এই ভ্যালুগুলো যোগ করুন:

| Variable Key | Value |
|---|---|
| `ROUTER_URL` | `https://103.132.220.121:8443` |
| `API_USER` | `api-hotspot` |
| `API_PASS` | `Hotspot@1036Pass!` |
| `SECRET_PEPPER` | `HotspotSecretKey2025` |

---

## 📡 MikroTik RouterOS v7 কনফিগারেশন

আপনার MikroTik টার্মিনালে নিচের কমান্ডগুলো পেস্ট করুন:

```routeros
# ১. রিয়েল আইপি 103.132.220.121 দিয়ে SSL সার্টিফিকেট তৈরি
/certificate
add name="realip-ssl" common-name="103.132.220.121" days-valid=3650 key-usage=digital-signature,key-encipherment,tls-server
sign realip-ssl

# ২. REST API ইউজার ও গ্রুপ তৈরি
/user group
add name=rest-api-group policy=read,write,api,rest-api comment="API Group for Vercel"

/user
add name=api-hotspot group=rest-api-group password="Hotspot@1036Pass!" comment="Hotspot API User for Vercel"

# ৩. www-ssl (Port 8443) চালু করা
/ip service
set www-ssl port=8443 certificate=realip-ssl disabled=no
set api-ssl port=8729 disabled=no
set telnet disabled=yes
set ftp disabled=yes

# ৪. ফায়ারওয়াল: বাইরে থেকে Vercel-এর জন্য ৮৪৪৩ পোর্ট একসেপ্ট করা
/ip firewall filter
add chain=input action=accept protocol=tcp dst-port=8443 comment="Allow Vercel to MikroTik REST API" place-before=0

# ৫. হটস্পট প্রোফাইল ও সার্ভার তৈরি
/ip hotspot profile
add dns-name=login.wifi hotspot-address=192.168.88.1 html-directory=hotspot login-by=http-chap,http-pap name=hsprof1

/ip hotspot
add address-pool=LAN-POOL disabled=no interface=bridge-LAN name=hotspot1 profile=hsprof1

# ৬. হটস্পট ইউজার প্রোফাইল (5Mbps, ১ দিন মেয়াদ)
/ip hotspot user profile
add name=guest-profile rate-limit="5M/5M" shared-users=1 session-timeout=1d keepalive-timeout=1h status-autorefresh=1m comment="Auto-Registered Guest Mobile Users"

# ৭. Walled Garden
/ip hotspot walled-garden
add dst-host="*.vercel.app" action=allow comment="Allow Vercel Serverless API"
```

---

## 💻 গিট ও ডিপ্লয়মেন্ট কমান্ড

```bash
git init
git add .
git commit -m "MikroTik Hotspot Auto-Registration on Vercel"
git branch -M main
git remote add origin https://github.com/nipun-roy/hotspot.git
git push -u origin main
```
