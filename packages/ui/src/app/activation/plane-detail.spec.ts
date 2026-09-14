/**
 * The detail drawer's cross-highlighting.
 *
 * Three things can name the intersection both canvases mark -- the pointer over
 * the enlarged plane, the pointer over the board beside it, and the grid's own
 * hover -- and the bug this guards against is the two canvases disagreeing
 * about which one wins. The pixels are not asserted; the coordinate readout is
 * driven by the same value the highlights are, so it stands in for them.
 */

import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { squareBoardSize } from '@katascope/core';
import { describe, expect, it } from 'vitest';
import { BoardCanvas } from '../board/board-canvas';
import { PlaneDetail } from './plane-detail';

const SIZE = squareBoardSize(19);
/** The drawer draws the plane into a fixed 190px square. */
const BOX = 190;

function render() {
  const fixture = TestBed.createComponent(PlaneDetail);
  fixture.componentRef.setInput('block', 3);
  fixture.componentRef.setInput('channel', 7);
  fixture.componentRef.setInput('boardSize', SIZE);
  fixture.detectChanges();
  return fixture;
}

function label(fixture: ReturnType<typeof render>): string {
  const element = fixture.nativeElement as HTMLElement;
  return (element.querySelector('.detail__hover')?.textContent ?? '').trim();
}

/**
 * Points the plane canvas at a real box.
 *
 * jsdom lays nothing out, so every `getBoundingClientRect` is zeros and the
 * hit-test would correctly report "outside the box" for every point. Stubbing
 * the rect is what makes the pointer path testable at all.
 */
function stubPlaneRect(fixture: ReturnType<typeof render>): HTMLCanvasElement {
  const canvas = (fixture.nativeElement as HTMLElement).querySelector(
    'canvas.detail__plane',
  ) as HTMLCanvasElement;
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: BOX, height: BOX, right: BOX, bottom: BOX, x: 0, y: 0 }) as DOMRect;
  return canvas;
}

/** A pointer event at a point, as the canvas handler expects it. */
function pointerAt(type: string, x: number, y: number): Event {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, 'clientX', { value: x });
  Object.defineProperty(event, 'clientY', { value: y });
  return event;
}

describe('PlaneDetail cross-highlighting', () => {
  it('marks nothing when nothing is hovered', () => {
    const fixture = render();
    expect(label(fixture)).toBe('');
  });

  it('follows the grid hover when the pointer is up in the grid', () => {
    const fixture = render();
    fixture.componentRef.setInput('hover', { x: 3, y: 3 });
    fixture.detectChanges();
    // D16 on a 19x19 board: column 3, row 19 - 3.
    expect(label(fixture)).toContain('D16');
    expect(label(fixture)).toContain('(x 3, y 3)');
  });

  it('follows the pointer over the enlarged plane', () => {
    const fixture = render();
    const canvas = stubPlaneRect(fixture);
    const cell = BOX / 19;

    canvas.dispatchEvent(pointerAt('pointermove', 5 * cell + 2, 7 * cell + 2));
    fixture.detectChanges();
    expect(label(fixture)).toContain('(x 5, y 7)');
  });

  it('lets the plane pointer override a stale grid hover', () => {
    // Once the pointer is in the drawer it is no longer over a tile, but the
    // grid's last hover lingers until something replaces it.
    const fixture = render();
    fixture.componentRef.setInput('hover', { x: 0, y: 0 });
    fixture.detectChanges();
    expect(label(fixture)).toContain('(x 0, y 0)');

    const canvas = stubPlaneRect(fixture);
    const cell = BOX / 19;
    canvas.dispatchEvent(pointerAt('pointermove', 11 * cell + 2, 2 * cell + 2));
    fixture.detectChanges();
    expect(label(fixture)).toContain('(x 11, y 2)');
  });

  it('falls back to the grid hover when the pointer leaves the plane', () => {
    const fixture = render();
    fixture.componentRef.setInput('hover', { x: 1, y: 1 });
    const canvas = stubPlaneRect(fixture);
    const cell = BOX / 19;

    canvas.dispatchEvent(pointerAt('pointermove', 9 * cell + 2, 9 * cell + 2));
    fixture.detectChanges();
    expect(label(fixture)).toContain('(x 9, y 9)');

    canvas.dispatchEvent(new Event('pointerleave', { bubbles: true }));
    fixture.detectChanges();
    expect(label(fixture)).toContain('(x 1, y 1)');
  });

  it('marks nothing once the pointer leaves and there is no grid hover', () => {
    const fixture = render();
    const canvas = stubPlaneRect(fixture);
    canvas.dispatchEvent(pointerAt('pointermove', 20, 20));
    fixture.detectChanges();
    expect(label(fixture)).not.toBe('');

    canvas.dispatchEvent(new Event('pointerleave', { bubbles: true }));
    fixture.detectChanges();
    expect(label(fixture)).toBe('');
  });

  it('reports a pointer in the plane margin as no cell at all', () => {
    const fixture = render();
    const canvas = stubPlaneRect(fixture);
    // Just past the right edge: over the element's border, not over a cell.
    canvas.dispatchEvent(pointerAt('pointermove', BOX + 1, 10));
    fixture.detectChanges();
    expect(label(fixture)).toBe('');
  });

  it('passes the very same coordinate to the board canvas', () => {
    const fixture = render();
    fixture.componentRef.setInput('hover', { x: 4, y: 6 });
    fixture.detectChanges();

    // The ring itself is canvas pixels; what is assertable is that the board
    // got the same coordinate the readout shows, rather than a second,
    // independently-derived one that could drift from it.
    const board = fixture.debugElement.query(By.directive(BoardCanvas))
      .componentInstance as BoardCanvas;
    expect(board.highlight()).toEqual({ x: 4, y: 6 });
  });

  it('highlights the board from the plane pointer, which is the point', () => {
    const fixture = render();
    const canvas = stubPlaneRect(fixture);
    const cell = BOX / 19;
    canvas.dispatchEvent(pointerAt('pointermove', 15 * cell + 2, 3 * cell + 2));
    fixture.detectChanges();

    const board = fixture.debugElement.query(By.directive(BoardCanvas))
      .componentInstance as BoardCanvas;
    expect(board.highlight()).toEqual({ x: 15, y: 3 });
  });

  it('highlights the plane from the board pointer, the other direction', () => {
    const fixture = render();
    const board = fixture.debugElement.query(By.directive(BoardCanvas))
      .componentInstance as BoardCanvas;

    board.vertexHovered.emit({ x: 8, y: 12 });
    fixture.detectChanges();

    // Same shared value the plane canvas rings.
    expect(label(fixture)).toContain('(x 8, y 12)');
    expect(board.highlight()).toEqual({ x: 8, y: 12 });
  });

  it('drops the board highlight when the pointer leaves the board', () => {
    const fixture = render();
    const board = fixture.debugElement.query(By.directive(BoardCanvas))
      .componentInstance as BoardCanvas;

    board.vertexHovered.emit({ x: 8, y: 12 });
    fixture.detectChanges();
    expect(label(fixture)).not.toBe('');

    board.vertexHovered.emit(undefined);
    fixture.detectChanges();
    expect(label(fixture)).toBe('');
  });
});

describe('PlaneDetail channel identity', () => {
  it('shows channel 0, which is a channel like any other', () => {
    // Regression: the template asked `@if (channel(); as selected)`, and 0 is
    // falsy, so hovering the top-left tile of every block showed the empty
    // state. The grid's hit-testing was right the whole time.
    const fixture = TestBed.createComponent(PlaneDetail);
    fixture.componentRef.setInput('block', 2);
    fixture.componentRef.setInput('channel', 0);
    fixture.componentRef.setInput('boardSize', SIZE);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('[data-testid="detail-address"]')?.textContent?.trim()).toBe(
      '2.0',
    );
    expect(element.textContent).toContain('channel 0');
    expect(element.textContent).not.toContain('no channel');
  });

  it('still shows the empty state when nothing is selected', () => {
    const fixture = TestBed.createComponent(PlaneDetail);
    fixture.componentRef.setInput('block', 2);
    fixture.componentRef.setInput('boardSize', SIZE);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('[data-testid="detail-address"]')?.textContent).toContain('—');
    expect(element.textContent).toContain('no channel');
  });

  it('shows a reader norm of 0 rather than hiding the row', () => {
    const fixture = TestBed.createComponent(PlaneDetail);
    fixture.componentRef.setInput('block', 2);
    fixture.componentRef.setInput('channel', 5);
    fixture.componentRef.setInput('boardSize', SIZE);
    fixture.componentRef.setInput('readerNorm', 0);
    fixture.detectChanges();

    // A channel nothing reads is a finding, not a missing measurement.
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('[data-testid="detail-measures"]')?.textContent).toContain(
      'reader norm',
    );
  });
});
