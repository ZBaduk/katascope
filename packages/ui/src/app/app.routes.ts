import type { Routes } from '@angular/router';

/**
 * Top-level tabs. Each is lazily loaded so a feature area's code never lands in
 * the initial bundle just by existing.
 */
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'board' },
  {
    path: 'board',
    title: 'katascope - Board',
    loadComponent: () => import('./board/board-page').then((m) => m.BoardPage),
  },
  {
    path: 'diagnostics',
    title: 'katascope - Diagnostics',
    loadComponent: () => import('./diagnostics/diagnostics-page').then((m) => m.DiagnosticsPage),
  },
  { path: '**', redirectTo: 'board' },
];
