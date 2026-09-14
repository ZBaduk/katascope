import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter, withHashLocation } from '@angular/router';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Signals everywhere; zone.js is not a dependency of this app.
    provideZonelessChangeDetection(),
    // A packaged build is served from file://, where path-based routing has no
    // origin to resolve against. Hash routing works in both dev and production.
    provideRouter(routes, withHashLocation()),
  ],
};
