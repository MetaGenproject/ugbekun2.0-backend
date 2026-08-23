import crypto from 'crypto';
import dns from 'node:dns/promises';

export const DEFAULT_DNS_TARGET = process.env.DEFAULT_DNS_TARGET || 'cname.ugbekun.edu.ng';
export const PLATFORM_APEX_DOMAINS = [
  'ugbekun.edu.ng',
  'ugbekun-beta.vercel.app',
  'ugbekun.com',
  'localhost',
  '127.0.0.1'
];

export interface DnsVerificationResult {
  domain: string;
  verified: boolean;
  cnameMatch: boolean;
  txtMatch: boolean;
  records: {
    cname: string[];
    txt: string[];
    a: string[];
  };
  message: string;
  checkedAt: string;
}

/**
 * Sanitizes school name or code into an RFC 1035-compliant DNS subdomain slug
 */
export function formatDomainSlug(input: any): string {
  if (!input) return '';
  return String(input)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63);
}

/**
 * Generates a cryptographic verification token for DNS challenge
 */
export function generateDomainVerificationToken(branchId: number | string): string {
  const randomHex = crypto.randomBytes(8).toString('hex');
  return `ugbekun-verify-${branchId}-${randomHex}`;
}

/**
 * Normalizes host header string by removing port and lowercasing
 */
export function normalizeHostname(rawHost: any): string {
  if (!rawHost) return '';
  let host = String(rawHost).trim().toLowerCase();
  if (host.includes(':')) {
    host = host.split(':')[0];
  }
  return host;
}

/**
 * Live DNS Query Engine: Verifies CNAME, TXT, and A records against public DNS nameservers
 */
export async function verifyDomainDns(
  domain: string,
  expectedToken?: string,
  expectedTarget: string = DEFAULT_DNS_TARGET
): Promise<DnsVerificationResult> {
  const cleanDomain = normalizeHostname(domain);
  const result: DnsVerificationResult = {
    domain: cleanDomain,
    verified: false,
    cnameMatch: false,
    txtMatch: false,
    records: {
      cname: [],
      txt: [],
      a: []
    },
    message: '',
    checkedAt: new Date().toISOString()
  };

  if (!cleanDomain) {
    result.message = 'Domain name cannot be empty.';
    return result;
  }

  // 1. Check CNAME records
  try {
    const cnames = await dns.resolveCname(cleanDomain);
    result.records.cname = cnames;
    const normalizedTarget = normalizeHostname(expectedTarget);
    result.cnameMatch = cnames.some((c) => {
      const norm = normalizeHostname(c);
      return norm === normalizedTarget || norm.endsWith(normalizedTarget);
    });
  } catch (err) {
    result.records.cname = [];
  }

  // 2. Check A records (for root domains)
  try {
    const aRecords = await dns.resolve4(cleanDomain);
    result.records.a = aRecords;
  } catch (err) {
    result.records.a = [];
  }

  // 3. Check TXT verification records
  try {
    const txtRecords = await dns.resolveTxt(cleanDomain);
    const flatTxt = txtRecords.map((chunks) => chunks.join(' '));
    result.records.txt = flatTxt;

    if (expectedToken) {
      result.txtMatch = flatTxt.some((t) =>
        t.includes(expectedToken) || t.includes(`ugbekun-verification=${expectedToken}`)
      );
    }
  } catch (err) {
    result.records.txt = [];
  }

  // Verification succeeds if CNAME matches target OR TXT challenge token matches
  if (result.cnameMatch || result.txtMatch) {
    result.verified = true;
    result.message = 'DNS records successfully verified and connected.';
  } else if (result.records.cname.length > 0) {
    result.message = `Found CNAME (${result.records.cname.join(', ')}) but it does not match expected target: ${expectedTarget}`;
  } else if (result.records.txt.length > 0) {
    result.message = `Found TXT records but none matched challenge token: ${expectedToken}`;
  } else {
    result.message = 'No CNAME or TXT records detected yet. DNS propagation may take up to 24-48 hours.';
  }

  return result;
}

/**
 * Resolves tenant Branch by incoming Host header or custom query parameters
 */
export async function resolveTenantByHost(prisma: any, rawHost: string) {
  const host = normalizeHostname(rawHost);
  if (!host) return null;

  // 1. Check if host matches a registered custom domain directly
  let branch = await prisma.branch.findFirst({
    where: {
      customDomain: host,
      active: true
    },
    include: {
      landingPage: true,
      systemSetting: true
    }
  });

  if (branch) {
    return {
      type: 'CUSTOM_DOMAIN',
      host,
      branch
    };
  }

  // 2. Check if host has "www." prefix or without "www."
  if (host.startsWith('www.')) {
    const nonWww = host.slice(4);
    branch = await prisma.branch.findFirst({
      where: {
        customDomain: nonWww,
        active: true
      },
      include: {
        landingPage: true,
        systemSetting: true
      }
    });

    if (branch) {
      return {
        type: 'CUSTOM_DOMAIN',
        host,
        branch
      };
    }
  }

  // 3. Check for platform subdomain (e.g. uiss.ugbekun.edu.ng or uiss.localhost)
  for (const apex of PLATFORM_APEX_DOMAINS) {
    if (host.endsWith(`.${apex}`)) {
      const subdomainPart = host.replace(`.${apex}`, '');
      if (subdomainPart && subdomainPart !== 'www' && subdomainPart !== 'api') {
        branch = await prisma.branch.findFirst({
          where: {
            OR: [
              { subdomain: subdomainPart },
              { code: { equals: subdomainPart, mode: 'insensitive' } }
            ],
            active: true
          },
          include: {
            landingPage: true,
            systemSetting: true
          }
        });

        if (branch) {
          return {
            type: 'SUBDOMAIN',
            subdomain: subdomainPart,
            host,
            branch
          };
        }
      }
    }
  }

  // 4. Default: return null if not matched
  return null;
}

export default {
  formatDomainSlug,
  generateDomainVerificationToken,
  normalizeHostname,
  verifyDomainDns,
  resolveTenantByHost,
  DEFAULT_DNS_TARGET,
  PLATFORM_APEX_DOMAINS,
};
