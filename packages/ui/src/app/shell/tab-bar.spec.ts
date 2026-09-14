import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, withHashLocation } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { TabBar, type TabLink } from './tab-bar';

const TABS: readonly TabLink[] = [
  { path: '/board', label: 'Board' },
  { path: '/diagnostics', label: 'Diagnostics' },
];

@Component({ template: '', standalone: true })
class Blank {}

@Component({
  imports: [TabBar],
  template: '<ks-tab-bar [tabs]="tabs" />',
  standalone: true,
})
class Host {
  readonly tabs = TABS;
}

describe('TabBar', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(
          [
            { path: 'board', component: Blank },
            { path: 'diagnostics', component: Blank },
            { path: '**', component: Blank },
          ],
          withHashLocation(),
        ),
      ],
    });
  });

  it('renders one link per tab', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const links = fixture.nativeElement.querySelectorAll('a.tabs__tab') as NodeListOf<HTMLAnchorElement>;
    expect([...links].map((a) => a.textContent?.trim())).toEqual(['Board', 'Diagnostics']);
  });

  it('marks the tab matching the current route as selected', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/diagnostics');

    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    fixture.detectChanges();

    const links = [...fixture.nativeElement.querySelectorAll('a.tabs__tab')] as HTMLAnchorElement[];
    const selected = links.filter((a) => a.getAttribute('aria-selected') === 'true');
    expect(selected.map((a) => a.textContent?.trim())).toEqual(['Diagnostics']);
    expect(selected[0]?.classList.contains('tabs__tab--active')).toBe(true);
  });

  it('exposes the tablist roles assistive tech needs', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('nav')?.getAttribute('role')).toBe('tablist');
    const links = [...fixture.nativeElement.querySelectorAll('a.tabs__tab')] as HTMLAnchorElement[];
    expect(links.every((a) => a.getAttribute('role') === 'tab')).toBe(true);
  });
});
