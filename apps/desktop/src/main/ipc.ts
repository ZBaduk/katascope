/**
 * Implements the renderer-facing contract on top of the bridge.
 *
 * Handlers are written as a `KatascopeApi` object so the compiler checks every
 * signature against the shared contract, then registered by iterating the
 * contract's own method list -- a method can neither be forgotten here nor
 * registered on a channel that does not exist.
 *
 * Arguments arriving from the renderer are untrusted and validated before use,
 * even though the renderer is our own code: the IPC boundary is the last place
 * to catch a malformed request before it reaches a spawned process.
 */

import { app, dialog, ipcMain, BrowserWindow } from 'electron';
import { readFile } from 'node:fs/promises';
import { fileByteSource, type Bridge } from '@katascope/katago-bridge';
import {
  IPC_CHANNELS,
  IPC_METHODS,
  KactActivationStore,
  parseSgf,
  playerToMoveAt,
  type ActivationAvailability,
  type ActivationFrame,
  type ActivationKey,
  type BridgeStatus,
  type ConfigStatus,
  type GameRecord,
  type ActivationStore,
  type Attribution,
  type AttributionRequest,
  type AttributionTarget,
  type KatascopeApi,
  type BoardSize,
  type HeadWeights,
  type Move,
  type SetupStone,
  type ReaderWeights,
  type LoadedCapture,
  type LoadedGame,
  type PositionAnalysis,
  type PositionAnalysisRequest,
} from '@katascope/core';

export interface IpcContext {
  readonly bridge: Bridge;
  /** Config as loaded at startup, including any problems found in it. */
  readonly configStatus: ConfigStatus;
}

/**
 * The game the user last opened.
 *
 * Held in main rather than passed on every call: main has to parse the SGF
 * anyway to drive both the analysis engine and the activation service, and one
 * copy means the two cannot end up analysing different positions. The renderer
 * gets the same `GameRecord` back to draw from.
 */
interface OpenGame {
  readonly path: string;
  readonly game: GameRecord;
}

/** Registers every contract channel. Returns a function that unregisters them. */
export function registerIpcHandlers(context: IpcContext): () => void {
  let openGame: OpenGame | undefined;

  /**
   * The activation source in force.
   *
   * Defaults to whatever `createBridge` chose, and is replaced while a capture
   * is open. Held here rather than on the bridge because it is a UI-driven
   * choice, not a configuration one: the bridge still owns the live source to
   * go back to.
   */
  let capture: KactActivationStore | undefined;
  const activeStore = (): ActivationStore => capture ?? context.bridge.activationStore;

  const closeCapture = async (): Promise<void> => {
    const previous = capture;
    capture = undefined;
    await previous?.dispose();
  };

  const handlers: KatascopeApi = {
    getConfig: async (): Promise<ConfigStatus> => context.configStatus,

    getStatus: async (): Promise<BridgeStatus> => ({
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? 'unknown',
      nodeVersion: process.versions.node,
      chromeVersion: process.versions.chrome ?? 'unknown',
      subsystems: (await context.bridge.probe()).map((subsystem) =>
        subsystem.name === 'activation-store' && capture !== undefined
          ? {
              ...subsystem,
              mode: 'capture' as const,
              ready: true,
              detail: `capture ${capture.metadata.networkName}`,
            }
          : subsystem,
      ),
    }),

    openSgf: async (): Promise<LoadedGame | null> => {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const result = await (window === undefined
        ? dialog.showOpenDialog(OPEN_OPTIONS)
        : dialog.showOpenDialog(window, OPEN_OPTIONS));
      const path = result.filePaths[0];
      // Cancelling is a normal outcome, not an error.
      if (result.canceled || path === undefined) return null;

      const game = parseSgf(await readFile(path, 'utf8'));
      openGame = { path, game };
      // The activation service turns a move number into a position, so it needs
      // the same game the engine and the renderer have. `setGame` is on the
      // sidecar store, not on the `ActivationStore` interface -- the fake has
      // no use for a game -- so this is a capability check, not a cast.
      const store: unknown = context.bridge.activationStore;
      if (hasSetGame(store)) store.setGame(game);
      return { path, game };
    },

    setGame: async (game: GameRecord): Promise<LoadedGame> => {
      // Validated rather than trusted. This is the one handler whose argument
      // is a whole domain object, and it is handed straight to a spawned
      // Python process -- an out-of-range vertex or a 10-million-move record
      // would be that process's problem, and a crashed sidecar is the polite
      // end of the range of outcomes.
      const validated = parseGameRecord(game);
      const path = openGame?.path ?? '(played)';
      openGame = { path, game: validated };
      const store: unknown = context.bridge.activationStore;
      if (hasSetGame(store)) store.setGame(validated);
      return { path, game: validated };
    },

    analyzePosition: async (request: PositionAnalysisRequest): Promise<PositionAnalysis> => {
      const loaded = openGame;
      if (loaded === undefined) throw new Error('no game is open; call openSgf first');
      const moveNumber = requireNonNegativeInt(
        (request as { moveNumber?: unknown }).moveNumber,
        'moveNumber',
      );
      if (moveNumber > loaded.game.moves.length) {
        throw new RangeError(`move ${moveNumber} outside 0..${loaded.game.moves.length}`);
      }
      const maxVisits = Math.max(1, Math.round(numberOr(request.maxVisits, 1)));

      const { game } = loaded;
      const result = await context.bridge.analysisEngine.analyze({
        boardSize: game.size,
        rules: game.info.ruleset ?? 'chinese',
        komi: game.info.komi,
        initialStones: game.setup,
        moves: [...game.moves],
        turnNumber: moveNumber,
        maxVisits,
        includePolicy: true,
        includeOwnership: true,
        initialPlayer: playerToMoveAt(game, 0) === 'black' ? 'B' : 'W',
      });

      return {
        moveNumber,
        winrate: result.rootInfo.winrate,
        scoreLead: result.rootInfo.scoreLead,
        visits: result.rootInfo.visits,
        ...(result.policy === undefined ? {} : { policy: result.policy }),
        ...(result.ownership === undefined ? {} : { ownership: result.ownership }),
      };
    },

    openKact: async (): Promise<LoadedCapture | null> => {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const result = await (window === undefined
        ? dialog.showOpenDialog(KACT_OPTIONS)
        : dialog.showOpenDialog(window, KACT_OPTIONS));
      const path = result.filePaths[0];
      if (result.canceled || path === undefined) return null;

      const source = await fileByteSource(path);
      let store: KactActivationStore;
      try {
        store = await KactActivationStore.open(source);
      } catch (error) {
        await source.close?.();
        throw error;
      }

      await closeCapture();
      capture = store;

      const availability = await store.describe();
      const sgf = store.metadata.sgf;
      // A capture carries the SGF it was taken from, so opening one loads the
      // game too. Without it the move slider has nothing to label and the board
      // beside an enlarged plane has no stones.
      const game = sgf === undefined ? undefined : parseSgf(sgf);
      if (game !== undefined) openGame = { path, game };

      return {
        path,
        networkName: store.metadata.networkName,
        spec: availability.spec,
        moveNumbers: store.moveNumbers(),
        blockNumbers: store.blockNumbers(),
        ...(game === undefined ? {} : { game }),
        ...(store.metadata.createdAt === undefined ? {} : { createdAt: store.metadata.createdAt }),
      };
    },

    closeKact: async (): Promise<void> => {
      await closeCapture();
    },

    getReaderWeights: async (): Promise<ReaderWeights> => {
      const store = activeStore();
      if (store.readerWeights === undefined) {
        // A capture holds stored planes, not a model; there are no weights to
        // measure. Saying so beats returning zeros that look like an answer.
        throw new Error('the active activation source has no weights to read');
      }
      return store.readerWeights();
    },

    getHeadWeights: async (): Promise<HeadWeights> => {
      const store = activeStore();
      if (store.headWeights === undefined) {
        // Same reason as the reader weights: a capture is stored planes, and a
        // head cannot be re-run without the network that defines it.
        throw new Error('the active activation source has no head weights to read');
      }
      return store.headWeights();
    },

    attribute: async (request: AttributionRequest): Promise<Attribution> => {
      const store = activeStore();
      if (store.attribute === undefined) {
        throw new Error('the active activation source cannot be differentiated');
      }
      return store.attribute(parseAttributionRequest(request));
    },

    describeActivations: async (): Promise<ActivationAvailability> => activeStore().describe(),

    getActivationFrame: async (key: ActivationKey): Promise<ActivationFrame> =>
      activeStore().frame(parseActivationKey(key)),
  };

  for (const method of IPC_METHODS) {
    // The contract guarantees each method takes at most one argument; the cast
    // is the one place that erases the per-method signature to register it.
    const handler = handlers[method] as (argument: unknown) => Promise<unknown>;
    ipcMain.handle(IPC_CHANNELS[method], async (_event, argument: unknown) => handler(argument));
  }

  return () => {
    for (const method of IPC_METHODS) {
      ipcMain.removeHandler(IPC_CHANNELS[method]);
    }
    void closeCapture();
  };
}

/**
 * Validates an attribution request crossing the IPC boundary.
 *
 * The target reaches a spawned process and drives which tensor gets
 * differentiated, so every field is checked rather than forwarded.
 */
function parseAttributionRequest(value: unknown): AttributionRequest {
  if (value === null || typeof value !== 'object') {
    throw new TypeError('attribution request must be an object');
  }
  const raw = value as Record<string, unknown>;
  const moveNumber = requireNonNegativeInt(raw['moveNumber'], 'moveNumber');
  const target = parseAttributionTarget(raw['target']);
  const planeBlock = raw['planeBlock'];

  return {
    moveNumber,
    target,
    ...(planeBlock === undefined
      ? {}
      : { planeBlock: requireNonNegativeInt(planeBlock, 'planeBlock') }),
  };
}

function parseAttributionTarget(value: unknown): AttributionTarget {
  if (value === null || typeof value !== 'object') {
    throw new TypeError('attribution target must be an object');
  }
  const raw = value as Record<string, unknown>;
  const kind = raw['kind'];
  switch (kind) {
    case 'ownership_total':
    case 'winrate':
    case 'policy_pass':
      return { kind };
    case 'ownership_point':
    case 'policy_move':
      return {
        kind,
        x: requireNonNegativeInt(raw['x'], 'target.x'),
        y: requireNonNegativeInt(raw['y'], 'target.y'),
      };
    default:
      throw new TypeError(`unknown attribution target ${JSON.stringify(kind)}`);
  }
}

/** Validates an activation key crossing the IPC boundary. */
/**
 * Largest board this will accept.
 *
 * KataGo's own limit is 19 for the reference nets; the extra room is for a
 * larger network without a code change, and the cap exists at all so a record
 * claiming a 10,000-point board cannot make the sidecar allocate one.
 */
const MAX_BOARD_EDGE = 29;

/** Most moves a record may carry. A game is hundreds; this is thousands. */
const MAX_MOVES = 5_000;

function parseGameRecord(value: unknown): GameRecord {
  if (value === null || typeof value !== 'object') throw new TypeError('game must be an object');
  const raw = value as Record<string, unknown>;

  const size = parseBoardSize(raw['size']);
  const info = raw['info'];
  if (info === null || typeof info !== 'object') throw new TypeError('game.info must be an object');
  const rawInfo = info as Record<string, unknown>;

  const setupValue = raw['setup'];
  if (!Array.isArray(setupValue)) throw new TypeError('game.setup must be an array');
  const setup = setupValue.map((stone, index) => parseSetupStone(stone, size, index));

  const movesValue = raw['moves'];
  if (!Array.isArray(movesValue)) throw new TypeError('game.moves must be an array');
  if (movesValue.length > MAX_MOVES) {
    throw new RangeError(`game.moves has ${movesValue.length} entries, over the ${MAX_MOVES} limit`);
  }
  const moves = movesValue.map((move, index) => parseMove(move, size, index));

  // Only the fields the bridge reads are carried across. Anything else a
  // caller attached is dropped rather than forwarded unexamined.
  return {
    size,
    info: {
      komi: requireFiniteNumber(rawInfo['komi'], 'game.info.komi'),
      handicap: requireNonNegativeInt(rawInfo['handicap'], 'game.info.handicap'),
      ...optionalString(rawInfo['blackName'], 'blackName'),
      ...optionalString(rawInfo['whiteName'], 'whiteName'),
      ...optionalString(rawInfo['result'], 'result'),
    },
    setup,
    moves,
  };
}

function parseBoardSize(value: unknown): BoardSize {
  if (value === null || typeof value !== 'object') throw new TypeError('game.size must be an object');
  const raw = value as Record<string, unknown>;
  const width = requireNonNegativeInt(raw['width'], 'game.size.width');
  const height = requireNonNegativeInt(raw['height'], 'game.size.height');
  if (width < 1 || height < 1 || width > MAX_BOARD_EDGE || height > MAX_BOARD_EDGE) {
    throw new RangeError(`board ${width}x${height} outside 1..${MAX_BOARD_EDGE}`);
  }
  return { width, height };
}

function parseVertex(value: unknown, size: BoardSize, where: string): { x: number; y: number } {
  if (value === null || typeof value !== 'object') throw new TypeError(`${where} must be an object`);
  const raw = value as Record<string, unknown>;
  const x = requireNonNegativeInt(raw['x'], `${where}.x`);
  const y = requireNonNegativeInt(raw['y'], `${where}.y`);
  if (x >= size.width || y >= size.height) {
    throw new RangeError(`${where} ${x},${y} is off a ${size.width}x${size.height} board`);
  }
  return { x, y };
}

function parseColor(value: unknown, where: string): 'black' | 'white' {
  if (value !== 'black' && value !== 'white') {
    throw new TypeError(`${where} must be "black" or "white"`);
  }
  return value;
}

function parseSetupStone(value: unknown, size: BoardSize, index: number): SetupStone {
  if (value === null || typeof value !== 'object') {
    throw new TypeError(`game.setup[${index}] must be an object`);
  }
  const raw = value as Record<string, unknown>;
  return {
    color: parseColor(raw['color'], `game.setup[${index}].color`),
    vertex: parseVertex(raw['vertex'], size, `game.setup[${index}].vertex`),
  };
}

function parseMove(value: unknown, size: BoardSize, index: number): Move {
  if (value === null || typeof value !== 'object') {
    throw new TypeError(`game.moves[${index}] must be an object`);
  }
  const raw = value as Record<string, unknown>;
  const player = parseColor(raw['player'], `game.moves[${index}].player`);
  const kind = raw['kind'];
  if (kind === 'pass') return { kind: 'pass', player };
  if (kind !== 'play') throw new TypeError(`game.moves[${index}].kind must be "play" or "pass"`);
  return {
    kind: 'play',
    player,
    vertex: parseVertex(raw['vertex'], size, `game.moves[${index}].vertex`),
  };
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${field} must be a finite number`);
  }
  return value;
}

/** Keeps an optional string only when it is one, per `exactOptionalPropertyTypes`. */
function optionalString(value: unknown, key: string): Record<string, string> {
  return typeof value === 'string' ? { [key]: value } : {};
}

function parseActivationKey(value: unknown): ActivationKey {
  if (value === null || typeof value !== 'object') {
    throw new TypeError('activation key must be an object');
  }
  const raw = value as Record<string, unknown>;
  return {
    moveNumber: requireNonNegativeInt(raw['moveNumber'], 'moveNumber'),
    block: requireNonNegativeInt(raw['block'], 'block'),
  };
}

const KACT_OPTIONS: Electron.OpenDialogOptions = {
  title: 'Open activation capture',
  properties: ['openFile'],
  filters: [
    { name: 'katascope captures', extensions: ['kact'] },
    { name: 'All files', extensions: ['*'] },
  ],
};

const OPEN_OPTIONS: Electron.OpenDialogOptions = {
  title: 'Open SGF',
  properties: ['openFile'],
  filters: [
    { name: 'SGF game records', extensions: ['sgf'] },
    { name: 'All files', extensions: ['*'] },
  ],
};

/** True for a store that can be told which game its move numbers refer to. */
function hasSetGame(value: unknown): value is { setGame: (game: GameRecord) => void } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { setGame?: unknown }).setGame === 'function'
  );
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function requireNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return value;
}
