import 'dotenv/config';

const code = process.argv[2];
const res = await fetch(`${process.env.ZOHO_ACCOUNTS_URL}/oauth/v2/token`, {
  method: 'POST',
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    code,
  }),
});
const data = await res.json();
console.log(data.refresh_token ? 'REFRESH TOKEN:\n' + data.refresh_token : data);