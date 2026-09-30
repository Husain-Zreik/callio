// src/http/v1/validate.js
// Small request-validation helpers for the Management API. Each throws a 400
// HttpError naming the offending field.
import { badRequest } from '../errors.js';

export function requireString(body, field, { max = 255, optional = false } = {}) {
    const value = body?.[field];
    if (value == null || value === '') {
        if (optional) return null;
        throw badRequest(`${field} is required`);
    }
    if (typeof value !== 'string') throw badRequest(`${field} must be a string`);
    if (value.length > max) throw badRequest(`${field} must be at most ${max} characters`);
    return value;
}

export function optionalInt(body, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    const value = body?.[field];
    if (value == null) return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${field} must be an integer between ${min} and ${max}`);
    return n;
}

export function oneOf(body, field, allowed, { optional = false, fallback = null } = {}) {
    const value = body?.[field];
    if (value == null) {
        if (optional) return fallback;
        throw badRequest(`${field} is required`);
    }
    const upper = String(value).toUpperCase();
    if (!allowed.includes(upper)) throw badRequest(`${field} must be one of ${allowed.join(', ')}`);
    return upper;
}

export function optionalObject(body, field) {
    const value = body?.[field];
    if (value == null) return null;
    if (typeof value !== 'object' || Array.isArray(value)) throw badRequest(`${field} must be an object`);
    return value;
}

export function ref(value, what) {
    const s = String(value ?? '');
    if (!s || s.length > 191) throw badRequest(`${what} reference must be 1-191 characters`);
    return s;
}

// An optional ISO 8601 date-time (query or body); null when absent.
export function optionalTimestamp(obj, field) {
    const value = obj?.[field];
    if (value == null || value === '') return null;
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) throw badRequest(`${field} must be an ISO 8601 date-time`);
    return date;
}
