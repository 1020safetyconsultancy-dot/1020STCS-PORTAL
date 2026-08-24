# 1020 Safety Portal

Secure, browser-based portal for 1020 Safety Training Consultancy Services.

## Online access

The portal uses Supabase Auth and PostgreSQL so approved users can access synchronized records from computers and mobile devices.

- Administrator account: `1020safetyconsultancy@gmail.com`
- Clients register with their email address and password.
- New users may need to confirm their email before signing in.
- The selected login role must match the role assigned to the account.

## Access control

- Administrators can access all portal records.
- Consultants can access operational records.
- Clients can access only records owned by their account.
- Training programs and published schedules are readable by signed-in users.
- Anonymous database access is disabled.

The publishable browser key is intentionally public and is protected by PostgreSQL row-level security. Secret and service-role keys must never be committed to this repository.

## Publishing

Publish `index.html` from the `main` branch using GitHub Pages.
