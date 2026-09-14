/**
 * Providers installed in the Angular TestBed for every UI spec.
 *
 * The app is zoneless, so the tests must be too -- a component that only passes
 * under zone.js change detection is a component that will not work in the app.
 */

import {
  provideZonelessChangeDetection,
  type EnvironmentProviders,
  type Provider,
} from '@angular/core';

const providers: (Provider | EnvironmentProviders)[] = [provideZonelessChangeDetection()];

export default providers;
