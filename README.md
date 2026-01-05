# ChatWithFriend — Backend

Simple Node.js backend with:

- JWT authentication (signup / login)
- Add friend
- Online/offline status tracking
- Real-time private chat via Socket.IO
- MongoDB (Mongoose) persistence for users and messages

Setup

1. Create a `.env` or set `MONGO_URI` and `JWT_SECRET` in your environment.
2. Install deps:

```bash
npm install
```

3. Run in dev:

```bash
npm run dev
```

Socket.IO expects a connect payload with `auth: { token }` where `token` is the JWT returned from `/api/auth/login`.
