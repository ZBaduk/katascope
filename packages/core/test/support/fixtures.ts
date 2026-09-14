/**
 * Fixture access for core's tests.
 *
 * Tests run under Node; the package under test does not. `node:fs` is legitimate
 * here and nowhere in `src/`. Always load fixtures through these helpers rather
 * than a hand-built relative path, so moving the directory is one edit.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures');

export function fixturePath(...segments: readonly string[]): string {
  return join(FIXTURE_ROOT, ...segments);
}

export function readTextFixture(...segments: readonly string[]): string {
  return readFileSync(fixturePath(...segments), 'utf8');
}

export function readBinaryFixture(...segments: readonly string[]): Buffer {
  return readFileSync(fixturePath(...segments));
}

export function readSgfFixture(name: string): string {
  return readTextFixture('sgf', name);
}

/** Every `.sgf` in `fixtures/sgf`, sorted, so a new fixture is picked up automatically. */
export function listSgfFixtures(): readonly string[] {
  return readdirSync(fixturePath('sgf'))
    .filter((name) => name.endsWith('.sgf'))
    .sort();
}
