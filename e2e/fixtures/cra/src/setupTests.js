// Like copy-requisition: jest-dom plus project hooks around every test.
import '@testing-library/jest-dom';
import { resetCounters, countTest } from './counters';

beforeEach(() => {
  resetCounters();
});

afterEach(() => {
  countTest();
});
