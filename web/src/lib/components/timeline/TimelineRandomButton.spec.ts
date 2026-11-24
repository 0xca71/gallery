import { test } from '#test/unit/fixtures.ts';
import { expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import TimelineRandomButton from './TimelineRandomButton.svelte';

test('shows the existing Gallery loader while the filtered random jump is pending', async () => {
  await render(TimelineRandomButton, { loading: true, onclick: vi.fn() });
  const button = page.getByTestId('timeline-random-button');
  await expect.element(button).toBeDisabled();
  await expect.element(button).toHaveAttribute('aria-busy', 'true');
  const loader = page.getByRole('status');
  await expect.element(loader).toBeInTheDocument();
  expect(loader.element().getAttribute('src')).toMatch(/\/gallery-loader(?:-dark)?\.svg$/);
});
