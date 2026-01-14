// Simple in-memory call manager for REST endpoints
// Note: persists only for process lifetime. Replace with DB if needed.

const calls = new Map();

function makeId() {
    return Date.now().toString() + '-' + Math.random().toString(36).slice(2, 8);
}

// Try to persist using Mongoose Call model if available
async function createCall({ from, to, metadata }) {
    const id = makeId();
    const call = {
        id,
        from: String(from),
        to: String(to),
        status: 'ringing',
        metadata: metadata || {},
        createdAt: new Date().toISOString()
    };
    // store in memory first
    calls.set(id, call);

    // attempt to persist
    try {
        const CallModel = require('./models/Call');
        const doc = await CallModel.create({ from, to, status: call.status, metadata: call.metadata, createdAt: call.createdAt });
        // sync id with DB _id
        call.id = String(doc._id);
        calls.set(call.id, call);
        return call;
    } catch (e) {
        // no DB available or error — fall back to in-memory
        return call;
    }
}

function getCall(id) {
    return calls.get(String(id)) || null;
}

async function acceptCall(id) {
    const c = calls.get(String(id));
    if (!c) return null;
    c.status = 'in-progress';
    c.acceptedAt = new Date().toISOString();
    calls.set(c.id, c);
    try {
        const CallModel = require('./models/Call');
        await CallModel.findByIdAndUpdate(String(id), { status: 'in-progress', acceptedAt: c.acceptedAt }, { new: true });
    } catch (e) { }
    return c;
}

async function endCall(id, reason) {
    const c = calls.get(String(id));
    if (!c) return null;
    c.status = 'ended';
    c.endedAt = new Date().toISOString();
    if (reason) c.reason = String(reason);
    calls.set(c.id, c);
    try {
        const CallModel = require('./models/Call');
        await CallModel.findByIdAndUpdate(String(id), { status: 'ended', endedAt: c.endedAt, reason: c.reason }, { new: true });
    } catch (e) { }
    return c;
}

function listCallsForUser(userId) {
    const uid = String(userId);
    return Array.from(calls.values()).filter(c => c.from === uid || c.to === uid);
}

module.exports = { createCall, getCall, acceptCall, endCall, listCallsForUser };
