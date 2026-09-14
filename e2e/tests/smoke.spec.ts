/**
 * The one test that exercises everything at once.
 *
 * Main process, preload bridge, IPC, and the renderer, in the built app. If
 * this passes, the wiring is intact; unit tests cover whether the pieces are
 * individually correct.
 *
 * Steps that need features which do not exist yet are `test.fixme` -- they
 * report as expected-failures rather than quietly not existing. Un-fixme each
 * one in the commit that adds the feature it names.
 */

import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { KACT_FIXTURES, launchApp, SGF_FIXTURES, type LaunchedApp } from '../support/launch.js';

let launched: LaunchedApp;

test.beforeEach(async () => {
  launched = await launchApp();
});

test.afterEach(async () => {
  await launched?.close();
});

test('opens a window with both tabs', async () => {
  const { page } = launched;

  await expect(page.locator('ks-root')).toBeVisible();
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(0)).toHaveText('Board');
  await expect(tabs.nth(1)).toHaveText('Diagnostics');
});

test('starts on the Board tab', async () => {
  const { page } = launched;

  await expect(page.getByRole('tab', { name: 'Board' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Open SGF' })).toBeVisible();
  await expect(page.locator('ks-board-canvas canvas')).toBeVisible();
});

test('exposes only the contract methods on the preload bridge', async () => {
  const { page } = launched;

  // Guards the security posture: if `ipcRenderer` ever leaks onto the window,
  // this is where it gets caught.
  const exposed = await page.evaluate(() => Object.keys(window.katascope ?? {}).sort());
  expect(exposed).toEqual([
    'analyzePosition',
    'attribute',
    'closeKact',
    'describeActivations',
    'getActivationFrame',
    'getConfig',
    'getHeadWeights',
    'getReaderWeights',
    'getStatus',
    'openKact',
    'openSgf',
    'setGame',
  ]);
  expect(await page.evaluate(() => 'require' in window)).toBe(false);
  expect(await page.evaluate(() => 'ipcRenderer' in window)).toBe(false);
});

test('switches to Diagnostics and reports both subsystems over IPC', async () => {
  const { page } = launched;

  await page.getByRole('tab', { name: 'Diagnostics' }).click();
  // Diagnostics opens on the activation grid; the runtime report is a sub-tab.
  await page.getByRole('tab', { name: 'Runtime' }).click();
  await expect(page.getByRole('heading', { name: 'Diagnostics' })).toBeVisible();

  // Every row here came from the main process, so a rendered row proves the
  // whole IPC round trip.
  const subsystems = page.locator('.subsystem');
  await expect(subsystems).toHaveCount(2);
  await expect(subsystems.nth(0)).toContainText('analysis-engine');
  await expect(subsystems.nth(1)).toContainText('activation-store');
  await expect(page.locator('.subsystem .dot--ok')).toHaveCount(2);
  await expect(page.getByText('b6c96')).toBeVisible();
});

test('ships an activation frame across the IPC boundary intact', async () => {
  const { page } = launched;

  const frame = await page.evaluate(async () => {
    const api = window.katascope;
    if (api === undefined) throw new Error('no bridge');
    const result = await api.getActivationFrame({ moveNumber: 12, block: 3 });
    return {
      constructor: result.data.constructor.name,
      length: result.data.length,
      channels: result.channels,
      dtype: result.dtype,
    };
  });

  // A typed array must survive structured clone as a typed array; arriving as
  // a plain object or an array of numbers is the failure this catches.
  // The fake store serves a b6c96 net, which is what the fixture config pins.
  expect(frame.constructor).toBe('Float32Array');
  expect(frame.channels).toBe(96);
  expect(frame.length).toBe(96 * 19 * 19);
  expect(frame.dtype).toBe('float32');
});

test('rejects an out-of-range frame request without crashing the renderer', async () => {
  const { page } = launched;

  const message = await page.evaluate(async () => {
    try {
      await window.katascope?.getActivationFrame({ moveNumber: 0, block: 9999 });
      return 'no error';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
  expect(message).toContain('outside 0..');

  await expect(page.locator('ks-root')).toBeVisible();
});

/* ------------------------------------------------------------------ *
 * The Board tab.                                                       *
 * ------------------------------------------------------------------ */

test('loads a fixture SGF', async () => {
  const { page } = launched;
  await launched.stubOpenDialog(join(SGF_FIXTURES, 'simple-game.sgf'));

  await page.getByRole('button', { name: 'Open SGF' }).click();

  // The summary is built from the parsed record, so seeing it means the file
  // was read in main, parsed, and handed back across IPC intact.
  await expect(page.getByTestId('game-summary')).toContainText('Black Player vs White Player');
  await expect(page.getByTestId('game-summary')).toContainText('19×19');
  await expect(page.getByTestId('move-number')).toHaveText('0');
});

test('steps forward and back through moves', async () => {
  const { page } = launched;
  await launched.stubOpenDialog(join(SGF_FIXTURES, 'simple-game.sgf'));
  await page.getByRole('button', { name: 'Open SGF' }).click();
  await expect(page.getByTestId('game-summary')).toContainText('Black Player');

  await page.getByTitle(/Next move/).click();
  await expect(page.getByTestId('move-number')).toHaveText('1');

  await page.getByTitle(/Next move/).click();
  await expect(page.getByTestId('move-number')).toHaveText('2');

  await page.getByTitle(/Previous move/).click();
  await expect(page.getByTestId('move-number')).toHaveText('1');

  await page.getByTitle(/Last move/).click();
  // simple-game.sgf has 18 moves.
  await expect(page.getByTestId('move-number')).toHaveText('18');

  await page.getByTitle(/First move/).click();
  await expect(page.getByTestId('move-number')).toHaveText('0');
});

test('steps moves with the keyboard', async () => {
  const { page } = launched;
  await launched.stubOpenDialog(join(SGF_FIXTURES, 'simple-game.sgf'));
  await page.getByRole('button', { name: 'Open SGF' }).click();
  await expect(page.getByTestId('game-summary')).toContainText('Black Player');

  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('move-number')).toHaveText('2');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('move-number')).toHaveText('1');
});

test('carries the move selection across to the Diagnostics tab', async () => {
  const { page } = launched;
  await launched.stubOpenDialog(join(SGF_FIXTURES, 'simple-game.sgf'));
  await page.getByRole('button', { name: 'Open SGF' }).click();
  await page.getByTitle(/Next move/).click();
  await page.getByTitle(/Next move/).click();
  await page.getByTitle(/Next move/).click();

  await page.getByRole('tab', { name: 'Diagnostics' }).click();
  await page.getByRole('tab', { name: 'Runtime' }).click();
  // The selection is app-wide state, so the other tab has already followed.
  await expect(page.getByTestId('session-move')).toContainText('3 / 18');
  await expect(page.getByTestId('session-game')).toContainText('simple-game.sgf');
});

test('keeps the loaded game when the dialog is cancelled', async () => {
  const { page } = launched;
  await launched.stubOpenDialog(join(SGF_FIXTURES, 'simple-game.sgf'));
  await page.getByRole('button', { name: 'Open SGF' }).click();
  await expect(page.getByTestId('game-summary')).toContainText('Black Player');

  await launched.stubCancelledDialog();
  await page.getByRole('button', { name: 'Open SGF' }).click();
  await expect(page.getByTestId('game-summary')).toContainText('Black Player');
});

test('loads a handicap game with its setup stones', async () => {
  const { page } = launched;
  await launched.stubOpenDialog(join(SGF_FIXTURES, 'handicap-4.sgf'));
  await page.getByRole('button', { name: 'Open SGF' }).click();
  await expect(page.getByTestId('game-summary')).toContainText('Student vs Teacher');
  await expect(page.getByTestId('move-number')).toHaveText('0');
});

test('warns that the analysis engine is a fake', async () => {
  // The fixture config pins useFakes, so every overlay number is synthetic and
  // the banner must say so.
  const { page } = launched;
  await expect(page.getByTestId('fake-banner')).toContainText('Fake data');
});

test('fetches an ownership overlay only once it is switched on', async () => {
  const { page } = launched;
  await launched.stubOpenDialog(join(SGF_FIXTURES, 'simple-game.sgf'));
  await page.getByRole('button', { name: 'Open SGF' }).click();
  await expect(page.getByTestId('analysis-status')).toHaveCount(0);

  await page.getByText('Ownership', { exact: true }).click();
  await expect(page.getByTestId('analysis-status')).toContainText(/winrate/);
});

test('selects a block and shows its activations', async () => {
  const { page } = launched;
  await page.getByRole('tab', { name: 'Diagnostics' }).click();

  // The fake store serves a b6c96 net: six blocks, 96 channels.
  await expect(page.getByTestId('grid-status')).toContainText('96 channels');
  await expect(page.locator('.rail__block')).toHaveCount(6);
  await expect(page.locator('ks-channel-grid canvas')).toBeVisible();

  // Block 0 sits at the bottom of the rail, so the first entry is the deepest.
  await expect(page.locator('.rail__block').first()).toHaveText('5');
  await page.locator('.rail__block[data-block="3"]').click();
  await expect(page.getByTestId('grid-status')).toContainText('block 3');
  await expect(page.locator('.rail__block--selected')).toHaveText('3');
});

test('opens a .kact capture and takes its game and blocks from it', async () => {
  const { page } = launched;
  await page.getByRole('tab', { name: 'Diagnostics' }).click();
  await launched.stubOpenDialog(join(KACT_FIXTURES, 'tiny-b2c3.kact'));

  await page.getByRole('button', { name: 'Open .kact' }).click();

  // The fixture is a 2-block, 3-channel toy capture of simple-game.sgf.
  await expect(page.getByTestId('capture-summary')).toContainText('fixture-b2c3');
  await expect(page.getByTestId('capture-summary')).toContainText('2 blocks');
  await expect(page.getByTestId('grid-status')).toContainText('3 channels');

  // The capture carries its SGF, so opening one loads the game too -- without
  // it the move slider has nothing to label.
  await page.getByRole('tab', { name: 'Board' }).click();
  await expect(page.getByTestId('game-summary')).toContainText('Black Player vs White Player');
});

test('steps moves while the activation grid is showing', async () => {
  const { page } = launched;
  await launched.stubOpenDialog(join(SGF_FIXTURES, 'simple-game.sgf'));
  await page.getByRole('button', { name: 'Open SGF' }).click();
  await expect(page.getByTestId('game-summary')).toContainText('Black Player');

  await page.getByRole('tab', { name: 'Diagnostics' }).click();
  await expect(page.getByTestId('grid-status')).toContainText('96 channels');
  // The grid follows SessionStore, so the Board tab's selection is already here.
  await page.getByRole('tab', { name: 'Board' }).click();
  await page.getByTitle(/Next move/).click();
  await page.getByTitle(/Next move/).click();
  await page.getByRole('tab', { name: 'Diagnostics' }).click();
  await page.getByRole('tab', { name: 'Runtime' }).click();
  await expect(page.getByTestId('session-move')).toContainText('2 / 18');
});


test('picks an attribution target on the board and sorts the grid by it', async () => {
  const { page } = launched;
  await launched.stubOpenDialog(join(SGF_FIXTURES, 'simple-game.sgf'));
  await page.getByRole('button', { name: 'Open SGF' }).click();
  await expect(page.getByTestId('game-summary')).toContainText('Black Player');

  // Clicking the board normally navigates; in attribution mode it picks a point.
  const clickAction = page.getByLabel('Click action');
  await clickAction.selectOption('ownership');
  // The middle of the canvas is reliably an intersection; a fixed offset can
  // land in the wood margin, which selects nothing by design.
  const board = page.locator('ks-board-canvas canvas');
  const box = (await board.boundingBox())!;
  await board.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(page.getByTestId('board-target')).toContainText('ownership at');

  // The target is app-wide state, so Diagnostics already has it.
  await page.getByRole('tab', { name: 'Diagnostics' }).click();
  await expect(page.getByTestId('grid-status')).toContainText('96 channels');
  await page.getByLabel('Channel ordering').selectOption('attribution');
  await expect(page.getByTestId('attribution-target')).toContainText('ownership at');
  await expect(page.getByTestId('grid-status')).not.toContainText('attributing…');
});

test('orders the grid by impact', async () => {
  const { page } = launched;
  await page.getByRole('tab', { name: 'Diagnostics' }).click();
  await expect(page.getByTestId('grid-status')).toContainText('96 channels');

  await page.getByLabel('Channel ordering').selectOption('impact');
  // The last block is the one the heads read, so it gains a head selector.
  await expect(page.getByLabel('Reader head')).toHaveCount(0);
  await page.locator('.rail__block[data-block="5"]').click();
  await expect(page.getByLabel('Reader head')).toHaveCount(1);
  await expect(page.getByTestId('grid-status')).toContainText('tinted by which head');
});

test('searches for channels that respond to a region picked on the board', async () => {
  const { page } = launched;

  // Region selection needs no game: which part of the board to ask about is a
  // question about the board, not about a position.
  await page.getByLabel('Click action').selectOption('region');

  const board = page.locator('ks-board-canvas canvas');
  const box = (await board.boundingBox())!;

  // `boardLayout` centres a square-celled grid with half a cell of margin plus
  // one cell per coordinate label, and 4px of padding. Reproduced here so the
  // clicks land on the intersections the fake store plants channels at --
  // clicking the middle of the canvas would select an arbitrary region and the
  // search would have nothing deterministic to find.
  const margin = 3; // 1 + 2 * labelCells, with labelCells = 1
  const cells = 19 - 1 + margin;
  const cell = Math.min((box.width - 8) / cells, (box.height - 8) / cells);
  const originX = (box.width - cells * cell) / 2 + (margin / 2) * cell;
  const originY = (box.height - cells * cell) / 2 + (margin / 2) * cell;
  const at = (x: number, y: number) => ({ x: originX + x * cell, y: originY + y * cell });

  await board.click({ position: at(3, 3) });
  await board.click({ position: at(4, 3) });
  await expect(page.getByTestId('board-region')).toContainText('D16 E16');

  // The region is app-wide state, so Diagnostics already has it.
  await page.getByRole('tab', { name: 'Diagnostics' }).click();
  await page.getByLabel('Region search').check();
  await expect(page.getByTestId('search-region')).toContainText('2 intersections selected');

  await page.getByTestId('search-run').click();
  await expect(page.getByTestId('search-status')).toContainText('hits');

  const rows = page.getByTestId('search-hits').locator('tbody tr');
  await expect(rows.first()).toBeVisible();

  // The fake store plants channels 7, 23 and 42 high on exactly this region,
  // so a "all high" search at the default threshold must surface them.
  const channels = await rows.locator('td:nth-child(3)').allInnerTexts();
  expect(channels).toContain('7');

  const first = rows.first();
  const block = (await first.locator('td:nth-child(2)').innerText()).trim();
  const channel = (await first.locator('td:nth-child(3)').innerText()).trim();

  await first.click();

  // Clicking a result selects that channel, which the grid rings and the detail
  // pane names. The address is the observable half of the highlight: the ring
  // itself is canvas pixels.
  await expect(page.getByTestId('detail-address')).toHaveText(`${block}.${channel}`);
  // The row marks itself as the current selection, which is driven by the same
  // app-wide state the grid highlights from.
  await expect(first).toHaveClass(/results__row--current/);
});

test('steps through the game from the Diagnostics tab', async () => {
  const { page } = launched;
  await launched.stubOpenDialog(join(SGF_FIXTURES, 'simple-game.sgf'));
  await page.getByRole('button', { name: 'Open SGF' }).click();
  await expect(page.getByTestId('game-summary')).toContainText('Black Player');

  await page.getByRole('tab', { name: 'Diagnostics' }).click();
  await expect(page.getByTestId('diag-move')).toContainText('move 0 / 18');

  // The point of the button: advancing without going back to the Board tab.
  await page.getByRole('button', { name: 'Next move' }).click();
  await expect(page.getByTestId('diag-move')).toContainText('move 1 / 18');
  await page.getByRole('button', { name: 'Next move' }).click();
  await expect(page.getByTestId('diag-move')).toContainText('move 2 / 18');

  await page.getByRole('button', { name: 'Previous move' }).click();
  await expect(page.getByTestId('diag-move')).toContainText('move 1 / 18');

  // The selection is app-wide, so the Board tab has already followed.
  await page.getByRole('tab', { name: 'Board' }).click();
  await expect(page.getByTestId('move-number')).toHaveText('1');
});

test('cross-highlights between the enlarged plane and the board beside it', async () => {
  const { page } = launched;
  await page.getByRole('tab', { name: 'Diagnostics' }).click();
  await expect(page.getByTestId('grid-status')).toContainText('96 channels');

  // Pin a channel so the drawer has a plane to hover.
  // Well inside the first tile. The grid's exact centre is not safe: with ten
  // columns it lands on the gutter between two of them, which pins nothing.
  const grid = page.locator('ks-channel-grid canvas');
  await grid.click({ position: { x: 40, y: 40 } });
  // Channel 0, which the drawer used to render as "no channel selected".
  await expect(page.getByTestId('detail-address')).toHaveText('0.0');

  const plane = page.locator('canvas.detail__plane');
  const box = (await plane.boundingBox())!;

  // The plane is stretched to fill its box, so cell (x, y) of 19 sits at
  // (x + 0.5) / 19 of the way across it.
  const cellCentre = (x: number, y: number) => ({
    x: ((x + 0.5) / 19) * box.width,
    y: ((y + 0.5) / 19) * box.height,
  });

  await plane.hover({ position: cellCentre(5, 7) });
  // The readout is driven by the same value both canvases ring, so it stands
  // in for the rings themselves, which are pixels.
  await expect(page.locator('.detail__hover')).toContainText('(x 5, y 7)');
  await expect(page.locator('.detail__hover')).toContainText('F12');

  await plane.hover({ position: cellCentre(0, 0) });
  await expect(page.locator('.detail__hover')).toContainText('(x 0, y 0)');

  // And the other direction: the board beside it drives the same highlight.
  const board = page.locator('ks-plane-detail ks-board-canvas canvas');
  const bbox = (await board.boundingBox())!;
  const margin = 3;
  const cells = 19 - 1 + margin;
  const cell = Math.min((bbox.width - 8) / cells, (bbox.height - 8) / cells);
  const ox = (bbox.width - cells * cell) / 2 + (margin / 2) * cell;
  const oy = (bbox.height - cells * cell) / 2 + (margin / 2) * cell;
  await board.hover({ position: { x: ox + 9 * cell, y: oy + 4 * cell } });
  await expect(page.locator('.detail__hover')).toContainText('(x 9, y 4)');
});

test('reduces the last block to a selection of channels', async () => {
  const { page } = launched;
  await page.getByRole('tab', { name: 'Diagnostics' }).click();
  await expect(page.getByTestId('grid-status')).toContainText('96 channels');

  // Reduce is offered only on the block the heads read.
  await expect(page.getByLabel('Reduce')).toHaveCount(0);
  await page.locator('.rail__block[data-block="5"]').click();
  await expect(page.getByTestId('grid-status')).toContainText('block 5');

  await page.getByLabel('Reduce').check();
  await expect(page.getByTestId('reduce-panel')).toBeVisible();
  await expect(page.getByTestId('reduce-count')).toContainText('0 of 96 selected');

  // Tick two tiles' checkboxes. They sit in each tile's top-left corner, so a
  // click a few pixels in selects rather than opening the channel.
  const grid = page.locator('ks-channel-grid canvas');
  const box = (await grid.boundingBox())!;
  const tile = box.width / 10; // ceil(sqrt(96)) = 10 columns
  await grid.click({ position: { x: 8, y: 8 } });
  await expect(page.getByTestId('reduce-count')).toContainText('1 of 96 selected');
  await grid.click({ position: { x: tile + 8, y: 8 } });
  await expect(page.getByTestId('reduce-count')).toContainText('2 of 96 selected');

  // The head actually ran: three boards, and a status line saying what it did.
  await expect(page.getByTestId('reduce-status')).toContainText('head re-run with only 2 channels');
  const boards = page.getByTestId('reduce-boards').locator('ks-board-canvas canvas');
  await expect(boards).toHaveCount(3);
  await expect(boards.first()).toBeVisible();

  // Switching mode re-runs rather than reusing the previous answer.
  await page.getByLabel('Reduce mode').selectOption('without');
  await expect(page.getByTestId('reduce-status')).toContainText(
    'head re-run without 2 channels',
  );

  // And the ownership head is a different question with the same selection.
  await page.getByLabel('Reduce head').selectOption('ownership');
  await expect(page.getByTestId('reduce-boards')).toBeVisible();

  await page.getByTestId('reduce-clear').click();
  await expect(page.getByTestId('reduce-count')).toContainText('0 of 96 selected');
});

test('plays a game against the reduced network', async () => {
  const { page } = launched;

  // The selection lives on Diagnostics; pick a couple of channels there first.
  await page.getByRole('tab', { name: 'Diagnostics' }).click();
  await page.locator('.rail__block[data-block="5"]').click();
  await page.getByLabel('Reduce').check();
  const grid = page.locator('ks-channel-grid canvas');
  const box = (await grid.boundingBox())!;
  const tile = box.width / 10;
  await grid.click({ position: { x: 8, y: 8 } });
  await grid.click({ position: { x: tile + 8, y: 8 } });
  await expect(page.getByTestId('reduce-count')).toContainText('2 of 96 selected');

  await page.getByRole('tab', { name: 'Board' }).click();
  await page.getByRole('button', { name: 'New game' }).click();
  await expect(page.getByTestId('game-summary')).toContainText('19×19');
  await expect(page.getByTestId('move-number')).toHaveText('0');

  // The bar names the selection the network is playing with, so a bad game is
  // attributable to a particular set of channels.
  await expect(page.getByTestId('play-status')).toContainText('only 2 channels');

  await page.getByLabel('Network side').selectOption('both');
  await page.getByTestId('play-step').click();
  await expect(page.getByTestId('move-number')).toHaveText('1');
  await page.getByTestId('play-step').click();
  await expect(page.getByTestId('move-number')).toHaveText('2');
  await expect(page.getByTestId('play-status')).toContainText('2 moves played');

  // And in real time, until stopped.
  await page.getByLabel('Move delay').fill('0');
  await page.getByTestId('play-start').click();
  await expect(page.getByTestId('play-stop')).toBeVisible();
  await expect(page.getByTestId('move-number')).not.toHaveText('2');
  await page.getByTestId('play-stop').click();
  await expect(page.getByTestId('play-start')).toBeVisible();

  // A human move is accepted too, and the network replies to it. Left on
  // "both" so the reply does not depend on which colour the loop stopped on --
  // with a single colour selected, a click that happens to fall on the
  // network's own turn is answered by nobody.
  const played = Number(await page.getByTestId('move-number').innerText());
  await page.getByLabel('Click action').selectOption('play');
  const board = page.locator('ks-board-canvas canvas').first();
  const bb = (await board.boundingBox())!;
  const cells = 21;
  const cell = Math.min((bb.width - 8) / cells, (bb.height - 8) / cells);
  const ox = (bb.width - cells * cell) / 2 + 1.5 * cell;
  const oy = (bb.height - cells * cell) / 2 + 1.5 * cell;
  await board.click({ position: { x: ox + 16 * cell, y: oy + 16 * cell } });
  // The human's stone plus the network's reply.
  await expect(page.getByTestId('move-number')).toHaveText(String(played + 2));
});

test('lets the human keep playing after the network has moved', async () => {
  // The reported bug: with a loaded SGF and no "New game", clicking the board
  // navigated to the move played there instead of placing a stone, so after
  // the network moved the player appeared to be locked out of their own game.
  const { page } = launched;

  await page.getByRole('tab', { name: 'Diagnostics' }).click();
  await page.locator('.rail__block[data-block="5"]').click();
  await page.getByLabel('Reduce').check();
  await page.locator('ks-channel-grid canvas').click({ position: { x: 8, y: 8 } });

  await page.getByRole('tab', { name: 'Board' }).click();
  await launched.stubOpenDialog(join(SGF_FIXTURES, 'simple-game.sgf'));
  await page.getByRole('button', { name: 'Open SGF' }).click();
  await expect(page.getByTestId('game-summary')).toContainText('Black');
  await page.getByTitle(/Last move/).click();
  await expect(page.getByTestId('move-number')).toHaveText('18');

  // Turning the network on switches clicking from "go to move" to "play a
  // stone" -- visibly, in the select, rather than by reinterpreting the click.
  await expect(page.getByLabel('Click action')).toHaveValue('off');
  await page.getByLabel('Network side').selectOption('both');
  await expect(page.getByLabel('Click action')).toHaveValue('play');

  await page.getByTestId('play-step').click();
  await expect(page.getByTestId('move-number')).toHaveText('19');

  const board = page.locator('ks-board-canvas canvas').first();
  const bb = (await board.boundingBox())!;
  const cells = 21;
  const cell = Math.min((bb.width - 8) / cells, (bb.height - 8) / cells);
  const ox = (bb.width - cells * cell) / 2 + 1.5 * cell;
  const oy = (bb.height - cells * cell) / 2 + 1.5 * cell;

  // An empty corner of the fixture game. The click must add a stone, not jump
  // backwards through the record.
  await board.click({ position: { x: ox + 2 * cell, y: oy + 16 * cell } });
  await expect(page.getByTestId('move-number')).toHaveText('21');

  // And again, so "after one move" is not a special case.
  await board.click({ position: { x: ox + 4 * cell, y: oy + 16 * cell } });
  await expect(page.getByTestId('move-number')).toHaveText('23');

  // Turning the network off hands clicking back to navigation.
  await page.getByLabel('Network side').selectOption('off');
  await expect(page.getByLabel('Click action')).toHaveValue('off');
});
