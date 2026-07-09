import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

export type Json =
    | string
    | number
    | boolean
    | null
    | { [key: string]: Json | undefined }
    | Json[]

const supabaseUrl = process.env.SUPABASE_URL;
// Acepta cualquiera de los nombres usados en distintos entornos (Render usa
// SUPABASE_SERVICE_KEY; el resto del código asumía SUPABASE_SERVICE_ROLE_KEY).
// Sin esto, el backend no encontraba la service key y Supabase no persistía nada.
const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('[supabase] FALTA configuración: define SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY (o SUPABASE_SERVICE_KEY) en el entorno.');
} else {
    const keyName = process.env.SUPABASE_SERVICE_ROLE_KEY ? 'SERVICE_ROLE_KEY'
        : process.env.SUPABASE_SERVICE_KEY ? 'SERVICE_KEY' : 'ANON_KEY';
    console.log(`[supabase] conectado · key=${keyName}`);
}

export const supabase = (supabaseUrl && supabaseKey)
    ? createClient(supabaseUrl, supabaseKey)
    : createClient('https://placeholder.supabase.co', 'placeholder-key-no-db');

// ============================================================
// USER REGISTRATION & AUTH
// ============================================================

/**
 * Register or update a user in registered_users table
 * Called on every successful login to keep data fresh
 */
export async function registerUser(
    email: string,
    name: string,
    department: string
): Promise<{ userId: string | null; isNewUser: boolean; role: string }> {
    try {
        if (!supabaseUrl || !supabaseKey) {
            return { userId: null, isNewUser: false, role: 'user' };
        }

        // Check if user already exists
        const { data: existing } = await supabase
            .from('registered_users')
            .select('id, role, login_count')
            .eq('email', email)
            .single();

        if (existing) {
            // Update last login and increment counter
            await supabase
                .from('registered_users')
                .update({
                    name,
                    department,
                    last_login: new Date().toISOString(),
                    login_count: (existing.login_count || 0) + 1,
                    updated_at: new Date().toISOString()
                })
                .eq('id', existing.id);

            console.log(`[Auth] Returning user: ${email} (${existing.role})`);
            return { userId: existing.id, isNewUser: false, role: existing.role || 'user' };
        }

        // New user - insert
        const { data: newUser, error } = await supabase
            .from('registered_users')
            .insert({
                email,
                name,
                department,
                role: 'user',
                is_active: true,
                last_login: new Date().toISOString(),
                login_count: 1
            })
            .select('id')
            .single();

        if (error) {
            console.error('[Auth] Registration error:', error);
            return { userId: null, isNewUser: true, role: 'user' };
        }

        // Create permissions for new user (restricted if pre-configured)
        if (newUser) {
            const clientAccess = CLIENT_ACCESS_MAP[email.toLowerCase()];
            const sections = clientAccess
                ? clientAccess.allowedSections
                : ['DASHBOARD', 'COMPETITORS', 'VOICE', 'AUDIENCE', 'INFLUENCER_CALCULATOR'];
            const permissions = sections.map(section => ({
                user_id: newUser.id,
                section,
                can_view: true,
                can_export: false,
                can_edit: false
            }));

            await supabase.from('user_permissions').insert(permissions);
        }

        console.log(`[Auth] New user registered: ${email}`);
        return { userId: newUser?.id || null, isNewUser: true, role: 'user' };
    } catch (err) {
        console.error('[Auth] Registration error:', err);
        return { userId: null, isNewUser: false, role: 'user' };
    }
}

/**
 * Start a new session for a user
 */
export async function startSession(
    userId: string,
    userAgent?: string,
    ipAddress?: string
): Promise<string | null> {
    try {
        if (!supabaseUrl || !supabaseKey || !userId) return null;

        const { data, error } = await supabase
            .from('user_sessions')
            .insert({
                user_id: userId,
                user_agent: userAgent || null,
                ip_address: ipAddress || null
            })
            .select('id')
            .single();

        if (error) {
            console.error('[Session] Error starting session:', error);
            return null;
        }

        return data?.id || null;
    } catch (err) {
        console.error('[Session] Error:', err);
        return null;
    }
}

/**
 * End a session
 */
export async function endSession(sessionId: string): Promise<void> {
    try {
        if (!supabaseUrl || !supabaseKey || !sessionId) return;

        await supabase
            .from('user_sessions')
            .update({ session_end: new Date().toISOString() })
            .eq('id', sessionId);
    } catch (err) {
        console.error('[Session] Error ending session:', err);
    }
}

/**
 * Get user permissions
 */
export async function getUserPermissions(email: string): Promise<Record<string, { canView: boolean; canExport: boolean; canEdit: boolean }>> {
    try {
        if (!supabaseUrl || !supabaseKey) return {};

        const { data: user } = await supabase
            .from('registered_users')
            .select('id, role')
            .eq('email', email)
            .single();

        if (!user) return {};

        // Admins get full access
        if (user.role === 'admin') {
            const sections = ['DASHBOARD', 'COMPETITORS', 'VOICE', 'AUDIENCE', 'INFLUENCER_CALCULATOR'];
            const result: Record<string, any> = {};
            sections.forEach(s => { result[s] = { canView: true, canExport: true, canEdit: true }; });
            return result;
        }

        const { data: perms } = await supabase
            .from('user_permissions')
            .select('section, can_view, can_export, can_edit')
            .eq('user_id', user.id);

        const result: Record<string, any> = {};
        (perms || []).forEach(p => {
            result[p.section] = {
                canView: p.can_view,
                canExport: p.can_export,
                canEdit: p.can_edit
            };
        });

        return result;
    } catch (err) {
        console.error('[Permissions] Error:', err);
        return {};
    }
}

/**
 * Check if a user already exists in registered_users by email.
 * Returns their profile data if found, null otherwise.
 */
export async function checkUserExists(email: string): Promise<{
    name: string;
    department: string;
    role: string;
    clientId?: string;
    allowedSections?: string[];
} | null> {
    try {
        if (!supabaseUrl || !supabaseKey) return null;

        const { data, error } = await supabase
            .from('registered_users')
            .select('name, department, role')
            .eq('email', email.toLowerCase())
            .single();

        if (error || !data) return null;

        const clientAccess = CLIENT_ACCESS_MAP[email.toLowerCase()];
        return {
            name: data.name,
            department: data.department,
            role: data.role || 'user',
            ...(clientAccess ? { clientId: clientAccess.clientId, allowedSections: clientAccess.allowedSections } : {}),
        };
    } catch (err) {
        console.error('[Auth] checkUserExists error:', err);
        return null;
    }
}

// ============================================================
// CLIENT ACCESS MAPPING — pre-configured access for specific users
// Add emails here to assign them a specific client dashboard + restricted sections
// ============================================================
export const CLIENT_ACCESS_MAP: Record<string, { clientId: string; allowedSections: string[] }> = {
    'diana.wiest.candamil@gmail.com': { clientId: 'ECI', allowedSections: ['COMPETITORS', 'AUDIENCE'] },
};

/**
 * Check if an email is allowed to register
 */
// Hardcoded allowed domains (always accepted without DB check)
const ALWAYS_ALLOWED_DOMAINS = ['@loymark.com'];

export async function isEmailAllowed(email: string): Promise<boolean> {
    try {
        if (!supabaseUrl || !supabaseKey) return true; // Fallback to allow if no DB

        const domain = '@' + email.split('@')[1];

        // Check hardcoded allowlist first
        if (ALWAYS_ALLOWED_DOMAINS.includes(domain.toLowerCase())) return true;

        const { data } = await supabase
            .from('allowed_emails')
            .select('id')
            .or(`email_or_domain.eq.${email},email_or_domain.eq.${domain}`);

        return (data && data.length > 0) || false;
    } catch (err) {
        console.error('[Auth] Email check error:', err);
        return true; // Fallback to allow
    }
}

/**
 * Get all registered users (admin only)
 */
export async function getAllUsers(): Promise<any[]> {
    try {
        if (!supabaseUrl || !supabaseKey) return [];

        const { data, error } = await supabase
            .from('registered_users')
            .select('id, email, name, department, role, is_active, last_login, login_count, created_at')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('[Users] Error fetching users:', error);
            return [];
        }

        return data || [];
    } catch (err) {
        console.error('[Users] Error:', err);
        return [];
    }
}

// ============================================================
// TOKEN USAGE TRACKING
// ============================================================

export async function logTokenUsage(
    model: string,
    section: string,
    functionName: string,
    inputTokens: number,
    outputTokens: number,
    userEmail?: string,
    brand?: string
) {
    try {
        const totalTokens = inputTokens + outputTokens;
        // Pricing per 1M tokens (USD) - approximate as of 2025
        const pricing: Record<string, { input: number; output: number }> = {
            'claude-opus-4-7': { input: 15, output: 75 },
            'claude-sonnet-4-6': { input: 3, output: 15 },
            'claude-haiku-4-5-20251001': { input: 0.8, output: 4 },
            'gemini-2.5-flash': { input: 0.15, output: 0.6 },
        };
        const rates = pricing[model] || { input: 3, output: 15 };
        const estimatedCost = (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;

        console.log(`[TOKENS] ${functionName} | ${model} | in:${inputTokens} out:${outputTokens} total:${totalTokens} | ~$${estimatedCost.toFixed(4)}`);

        if (!supabaseUrl || !supabaseKey) return;

        await supabase.from('token_usage').insert({
            model,
            section,
            function_name: functionName,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: totalTokens,
            estimated_cost_usd: estimatedCost,
            user_email: userEmail || 'unknown',
            brand: brand || null,
            created_at: new Date().toISOString()
        } as any);
    } catch (err) {
        // Fire-and-forget — never block analysis for logging
        console.error('[TOKENS] Logging error:', err);
    }
}

export async function getTokenStats(days: number = 30): Promise<any> {
    try {
        if (!supabaseUrl || !supabaseKey) return { error: 'No Supabase connection' };

        const since = new Date(Date.now() - days * 86400000).toISOString();

        const { data, error } = await supabase
            .from('token_usage')
            .select('*')
            .gte('created_at', since)
            .order('created_at', { ascending: false });

        if (error) return { error: error.message };

        const rows = data || [];

        // Aggregate by function
        const byFunction: Record<string, { calls: number; totalInput: number; totalOutput: number; totalCost: number; maxOutput: number; minOutput: number }> = {};
        rows.forEach((r: any) => {
            const key = r.function_name;
            if (!byFunction[key]) {
                byFunction[key] = { calls: 0, totalInput: 0, totalOutput: 0, totalCost: 0, maxOutput: 0, minOutput: Infinity };
            }
            byFunction[key].calls++;
            byFunction[key].totalInput += r.input_tokens;
            byFunction[key].totalOutput += r.output_tokens;
            byFunction[key].totalCost += r.estimated_cost_usd;
            byFunction[key].maxOutput = Math.max(byFunction[key].maxOutput, r.output_tokens);
            byFunction[key].minOutput = Math.min(byFunction[key].minOutput, r.output_tokens);
        });

        // Build summary
        const summary = Object.entries(byFunction).map(([fn, stats]) => ({
            function: fn,
            calls: stats.calls,
            avgInputTokens: Math.round(stats.totalInput / stats.calls),
            avgOutputTokens: Math.round(stats.totalOutput / stats.calls),
            maxOutputTokens: stats.maxOutput,
            minOutputTokens: stats.minOutput === Infinity ? 0 : stats.minOutput,
            totalCostUSD: parseFloat(stats.totalCost.toFixed(4)),
            avgCostPerCall: parseFloat((stats.totalCost / stats.calls).toFixed(4)),
        })).sort((a, b) => b.totalCostUSD - a.totalCostUSD);

        const totalCost = rows.reduce((sum: number, r: any) => sum + r.estimated_cost_usd, 0);

        return {
            period: `${days} days`,
            totalCalls: rows.length,
            totalCostUSD: parseFloat(totalCost.toFixed(4)),
            byFunction: summary,
            recentCalls: rows.slice(0, 20).map((r: any) => ({
                function: r.function_name,
                model: r.model,
                input: r.input_tokens,
                output: r.output_tokens,
                cost: r.estimated_cost_usd,
                brand: r.brand,
                user: r.user_email,
                date: r.created_at
            }))
        };
    } catch (err) {
        return { error: String(err) };
    }
}

// ============================================================
// BRAND PREDEFINED AUDIENCES
// ============================================================

/** Ensure the brand_predefined_audiences table exists */
export async function ensurePredefinedAudiencesTable(): Promise<void> {
    if (!supabaseUrl || !supabaseKey) return;
    try {
        // Try a read — if table doesn't exist, create it via RPC
        const { error } = await supabase.from('brand_predefined_audiences').select('brand').limit(1);
        if (error?.code === '42P01' || error?.message?.includes('does not exist')) {
            console.log('[Audiences] Creating brand_predefined_audiences table...');
            try {
                await supabase.rpc('exec_sql', { sql: `
                    CREATE TABLE IF NOT EXISTS brand_predefined_audiences (
                        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
                        brand text NOT NULL,
                        codename text NOT NULL,
                        sort_order int DEFAULT 0,
                        is_active boolean DEFAULT true,
                        created_at timestamptz DEFAULT now(),
                        UNIQUE(brand, codename)
                    );
                    CREATE INDEX IF NOT EXISTS idx_bpa_brand ON brand_predefined_audiences(brand);
                `});
            } catch {
                console.warn('[Audiences] Could not create table via RPC, please create manually');
            }
        }
    } catch (err) {
        console.warn('[Audiences] Table check failed:', err);
    }
}

/** Get predefined audiences for a brand */
export async function getBrandAudiences(brand: string): Promise<string[]> {
    try {
        if (!supabaseUrl || !supabaseKey) return [];
        const { data, error } = await supabase
            .from('brand_predefined_audiences')
            .select('codename, sort_order')
            .eq('brand', brand.toLowerCase().trim())
            .eq('is_active', true)
            .order('sort_order', { ascending: true });
        if (error) {
            console.error('[Audiences] Read error:', error.message);
            return [];
        }
        return (data || []).map((r: any) => r.codename);
    } catch { return []; }
}

/** Save predefined audiences for a brand (replaces existing) */
export async function saveBrandAudiences(brand: string, audiences: string[]): Promise<boolean> {
    try {
        if (!supabaseUrl || !supabaseKey) return false;
        const brandKey = brand.toLowerCase().trim();

        // Deactivate all existing
        await supabase
            .from('brand_predefined_audiences')
            .delete()
            .eq('brand', brandKey);

        if (audiences.length === 0) return true;

        // Insert new
        const rows = audiences.map((codename, i) => ({
            brand: brandKey,
            codename: codename.trim(),
            sort_order: i,
            is_active: true,
        }));

        const { error } = await supabase.from('brand_predefined_audiences').insert(rows);
        if (error) {
            console.error('[Audiences] Save error:', error.message);
            return false;
        }
        console.log(`[Audiences] Saved ${audiences.length} audiences for "${brand}"`);
        return true;
    } catch (err) {
        console.error('[Audiences] Save failed:', err);
        return false;
    }
}

/** Get all brands with predefined audiences */
export async function getAllBrandAudiences(): Promise<Record<string, string[]>> {
    try {
        if (!supabaseUrl || !supabaseKey) return {};
        const { data, error } = await supabase
            .from('brand_predefined_audiences')
            .select('brand, codename, sort_order')
            .eq('is_active', true)
            .order('sort_order', { ascending: true });
        if (error) return {};
        const result: Record<string, string[]> = {};
        (data || []).forEach((r: any) => {
            if (!result[r.brand]) result[r.brand] = [];
            result[r.brand].push(r.codename);
        });
        return result;
    } catch { return {}; }
}

// ============================================================
// ACTIVITY LOGGING (existing)
// ============================================================

export async function logActivity(
    actionType: string,
    details: object,
    userId?: string,
    sessionId?: string
) {
    try {
        const userName = (details as any)?.userName || 'anonymous';
        const userEmail = (details as any)?.userEmail || 'unknown';
        console.log(`[Supabase] Activity: ${actionType} | User: ${userName} (${userEmail})`);

        if (!supabaseUrl || !supabaseKey) return;

        // Enrich details with server timestamp (Colombia timezone)
        const now = new Date();
        const enrichedDetails = {
            ...details as any,
            timestamp_utc: now.toISOString(),
            timestamp_colombia: now.toLocaleString('es-CO', { timeZone: 'America/Bogota', hour12: false }),
        };

        const { error } = await supabase
            .from('user_activities')
            .insert({
                user_id: userId || null,
                session_id: sessionId || null,
                action_type: actionType,
                action_details: enrichedDetails as Json
            } as any);

        if (error) {
            console.error('Error logging activity:', error);
        }
    } catch (err) {
        console.error('Unexpected error logging to Supabase:', err);
    }
}


