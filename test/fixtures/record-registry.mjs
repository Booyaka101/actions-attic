/**
 * Records the real registry responses provenance.test.mjs runs against, so the
 * suite stays offline. Re-run it to refresh them:
 *
 *     node test/fixtures/record-registry.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'registry');
mkdirSync(OUT, { recursive: true });

const get = async (url) => {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'actions-attic' } });
  return { status: res.status, text: await res.text() };
};

// The packument, trimmed to what the tool reads: version list, publish times,
// and each version's dist.attestations pointer. The full document is ~200 KB of
// readme and maintainer metadata that has nothing to do with this.
async function packument(name, file) {
  const { status, text } = await get(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
  if (status !== 200) throw new Error(`${name}: HTTP ${status}`);
  const full = JSON.parse(text);
  const versions = {};
  for (const [v, meta] of Object.entries(full.versions)) {
    versions[v] = meta.dist?.attestations ? { dist: { attestations: meta.dist.attestations } } : {};
  }
  const trimmed = { name: full.name, 'dist-tags': full['dist-tags'], time: full.time, versions };
  writeFileSync(join(OUT, file), `${JSON.stringify(trimmed, null, 2)}\n`);
  console.log(`${file}: ${Object.keys(versions).length} versions`);
}

async function attestation(spec, file) {
  const { status, text } = await get(
    `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(spec)}`,
  );
  if (status !== 200) throw new Error(`${spec}: HTTP ${status}`);
  // Keep the DSSE payload byte for byte; drop the Sigstore verification material,
  // which is half the document and is not what this tool reads.
  const full = JSON.parse(text);
  const slim = {
    attestations: full.attestations.map((a) => ({
      predicateType: a.predicateType,
      bundle: {
        mediaType: a.bundle.mediaType,
        dsseEnvelope: { payloadType: a.bundle.dsseEnvelope.payloadType, payload: a.bundle.dsseEnvelope.payload },
      },
    })),
  };
  writeFileSync(join(OUT, file), `${JSON.stringify(slim, null, 2)}\n`);
  const ids = slim.attestations.map((a) => {
    const st = JSON.parse(Buffer.from(a.bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
    // v1 names the URL; v0.2 names `<run id>-<attempt>` and the git remote.
    return st.predicate?.runDetails?.metadata?.invocationId ?? st.predicate?.metadata?.buildInvocationId ?? '-';
  });
  console.log(`${file}: ${ids.join(' | ')}`);
}

await packument('runner-drift', 'runner-drift.packument.json');
await attestation('runner-drift@1.2.0', 'runner-drift-1.2.0.attestations.json');
await attestation('runner-drift@1.2.1', 'runner-drift-1.2.1.attestations.json');
await packument('@actions/core', 'actions-core.packument.json');
await attestation('@actions/core@3.0.1', 'actions-core-3.0.1.attestations.json');
// npm published SLSA v0.2 until early 2024, and those are the oldest runs, so the
// shape the most at-risk versions carry has to stay covered.
await attestation('sigstore@2.2.1', 'sigstore-2.2.1.attestations.json');
