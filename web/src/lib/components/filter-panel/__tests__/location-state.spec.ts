import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import LocationFilter from '../location-filter.svelte';

describe('LocationFilter state hierarchy', () => {
  it('auto-expands one country without selecting it, then lazy-loads state cities', async () => {
    const onSelectionChange = vi.fn();
    const onStateFetch = vi.fn().mockResolvedValue(['Bavaria']);
    const onCityFetch = vi.fn().mockResolvedValue(['Munich']);

    render(LocationFilter, {
      props: {
        countries: ['Germany'],
        onStateFetch,
        onCityFetch,
        onSelectionChange,
      },
    });

    expect(onSelectionChange).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('location-state-Bavaria')).toBeInTheDocument());
    expect(onSelectionChange).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByTestId('location-expand-state-Germany-Bavaria'));
    await waitFor(() => expect(screen.getByTestId('location-city-Germany-Bavaria-Munich')).toBeInTheDocument());
    expect(onCityFetch).toHaveBeenCalledWith('Germany', expect.objectContaining({ state: 'Bavaria' }));

    await fireEvent.click(screen.getByTestId('location-city-Germany-Bavaria-Munich'));
    expect(onSelectionChange).toHaveBeenLastCalledWith('Germany', 'Munich', 'Bavaria');
  });

  it('can collapse the automatically expanded country without changing filters', async () => {
    const onSelectionChange = vi.fn();
    render(LocationFilter, {
      props: {
        countries: ['Germany'],
        onStateFetch: () => Promise.resolve(['Bavaria']),
        onCityFetch: () => Promise.resolve([]),
        onSelectionChange,
      },
    });

    await waitFor(() => expect(screen.getByTestId('location-state-Bavaria')).toBeInTheDocument());
    await fireEvent.click(screen.getByTestId('location-expand-country-Germany'));
    expect(screen.queryByTestId('location-state-Bavaria')).toBeNull();
    expect(onSelectionChange).not.toHaveBeenCalled();
  });
});
