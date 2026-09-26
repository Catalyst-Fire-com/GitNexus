#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const EXTENSION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

// `FORCE INSTALL` re-downloads an existing file. Use it only for proven file
// corruption or a stale FTS build whose public wrapper calls a missing native
// helper. A missing file uses plain INSTALL; unrelated LOAD failures do not
// repeatedly download the same extension.
// Exported so a parity test keeps this byte-identical to the copy in
// src/core/lbug/extension-load-error.ts (this `.mjs` cannot import that `.ts`), #2383 F5b.
export const FILE_CORRUPTION_SIGNATURES = [
  /invalid elf/i,
  /file too short/i,
  /not a valid/i,
  /bad magic/i,
  /wrong architecture/i,
  /mach-o/i,
  /truncat/i,
];

const STALE_FTS_SIGNATURES = [
  /function _CREATE_FTS_INDEX does not exist/i,
  /function _QUERY_FTS_INDEX does not exist/i,
  /FTS capability probe exited with SIG(?:SEGV|ABRT)/i,
];

/**
 * Decide the install verb from the LOAD error that triggered this install.
 * `FORCE INSTALL` only for file corruption or a known stale FTS capability;
 * otherwise plain `INSTALL` (missing file, missing-dependency dlopen failure,
 * or unknown/absent error).
 */
export function chooseInstallVerb(loadError) {
  if (
    loadError &&
    (FILE_CORRUPTION_SIGNATURES.some((re) => re.test(loadError)) ||
      STALE_FTS_SIGNATURES.some((re) => re.test(loadError)))
  ) {
    return 'FORCE INSTALL';
  }
  return 'INSTALL';
}

function parseLbugMaxDbSize(raw) {
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid LadybugDB max DB size for extension installer: ${raw ?? '<missing>'}`);
  }
  return Math.floor(parsed);
}

function resolveMaxDbSize() {
  // argv[3] is the optional positional size; ignore it when it is actually a
  // flag token (e.g. `--verify-only`) and fall back to the env default.
  const sizeArg =
    process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : undefined;
  return parseLbugMaxDbSize(sizeArg ?? process.env.GITNEXUS_LBUG_MAX_DB_SIZE);
}

/** Open a scratch LadybugDB and return its connection plus a disposer. */
async function defaultConnect(lbugMaxDbSize, probeDir) {
  const require = createRequire(import.meta.url);
  const lbugModule = require('@ladybugdb/core');
  const lbug = lbugModule.default ?? lbugModule;

  const ownsTmpDir = !probeDir;
  const tmpDir = probeDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-ext-install-')));
  const dbPath = path.join(tmpDir, probeDir ? 'fts-capability-probe.lbug' : 'install.lbug');
  const db = new lbug.Database(dbPath, 0, false, false, lbugMaxDbSize);
  const conn = new lbug.Connection(db);
  return {
    conn,
    dispose: async () => {
      await conn.close().catch(() => {});
      await db.close().catch(() => {});
      if (ownsTmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

async function verifyFtsCapabilities(conn) {
  const table = 'GitNexusFtsCapabilityProbe';
  const index = 'gitnexus_fts_capability_probe';
  const functionsResult = await conn.query('CALL SHOW_FUNCTIONS() RETURN *');
  let functions;
  try {
    functions = await functionsResult.getAll();
  } finally {
    try {
      await functionsResult.close();
    } catch {
      // The scratch database is disposed below; a close failure does not mask
      // the capability result.
    }
  }
  const names = new Set(functions.map((row) => String(row.name ?? '').toUpperCase()));
  for (const name of ['CREATE_FTS_INDEX', 'QUERY_FTS_INDEX']) {
    if (!names.has(name)) throw new Error(`FTS capability probe: ${name} is not registered`);
  }

  // This is a real, on-disk LadybugDB database created by defaultConnect and
  // removed by its disposer. The throwaway table/index catches stale extension
  // builds whose public CREATE_FTS_INDEX wrapper exists but calls a missing
  // native helper such as _CREATE_FTS_INDEX.
  await conn.query(`CREATE NODE TABLE ${table}(name STRING, PRIMARY KEY(name))`);
  await conn.query('CREATE (:' + table + " {name: 'jkftsprobe'})");
  await conn.query(`CALL CREATE_FTS_INDEX('${table}', '${index}', ['name'])`);
  const queryResult = await conn.query(
    "CALL QUERY_FTS_INDEX('" + table + "', '" + index + "', 'jkftsprobe') RETURN node.name, score",
  );
  try {
    const rows = await queryResult.getAll();
    if (!rows.some((row) => String(row['node.name'] ?? '') === 'jkftsprobe')) {
      throw new Error('FTS capability probe created the index but could not query its row');
    }
  } finally {
    try {
      await queryResult.close();
    } catch {
      // The scratch database is disposed below; a close failure does not mask
      // the capability result.
    }
  }
}

/**
 * Install (or verify) an optional LadybugDB extension in this short-lived process.
 *
 * @param {string} extensionName
 * @param {object} [options]
 * @param {boolean} [options.verifyOnly] LOAD-only Docker build gate — no install.
 * @param {boolean} [options.verifyFtsCapability] Probe FTS functions on a real scratch DB.
 * @param {string} [options.loadError] The parent's LOAD failure; selects the verb.
 * @param {(size: number) => Promise<{conn: {query: (sql: string) => Promise<unknown>}, dispose: () => Promise<void>}>} [options.connect]
 *        Connection factory; injectable for offline unit tests.
 */
export async function installDuckDbExtension(extensionName, options = {}) {
  const { verifyOnly = false, verifyFtsCapability = false, loadError, connect } = options;
  if (!extensionName || !EXTENSION_NAME_PATTERN.test(extensionName)) {
    throw new Error(`Invalid DuckDB extension name: ${extensionName ?? '<missing>'}`);
  }

  const makeConnection =
    connect ??
    (() =>
      defaultConnect(
        resolveMaxDbSize(),
        verifyFtsCapability ? process.env.GITNEXUS_FTS_PROBE_DIR : undefined,
      ));
  const { conn, dispose } = await makeConnection();

  try {
    if (verifyOnly || verifyFtsCapability) {
      // Prove a previously-baked extension is resolvable by a FRESH process
      // under the current HOME (the runtime `LOAD EXTENSION` path) — no INSTALL,
      // no network. Used as a Docker build-time gate so a HOME/extension-dir
      // mismatch fails the build instead of silently degrading search at runtime.
      await conn.query(`LOAD EXTENSION ${extensionName}`);
      if (verifyFtsCapability) {
        if (extensionName.toLowerCase() !== 'fts') {
          throw new Error('--verify-fts-capability is only valid for the fts extension');
        }
        await verifyFtsCapabilities(conn);
        console.log(`[install-ext] FTS capability verify OK (HOME=${process.env.HOME})`);
      } else {
        console.log(
          `[install-ext] LOAD-only verify OK for '${extensionName}' (HOME=${process.env.HOME})`,
        );
      }
    } else {
      // Plain INSTALL is a no-op when the file already exists; escalate to FORCE
      // only when the LOAD error proves the on-disk file is broken (#2374).
      await conn.query(`${chooseInstallVerb(loadError)} ${extensionName}`);
    }
  } finally {
    await dispose();
  }
}

// Only run when executed directly — imported (e.g. by unit tests) it stays inert.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  installDuckDbExtension(process.argv[2] ?? process.env.GITNEXUS_LBUG_EXTENSION_NAME, {
    verifyOnly: process.argv.includes('--verify-only'),
    verifyFtsCapability: process.argv.includes('--verify-fts-capability'),
    loadError: process.env.GITNEXUS_LBUG_EXTENSION_LOAD_ERROR,
  }).catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  });
}
