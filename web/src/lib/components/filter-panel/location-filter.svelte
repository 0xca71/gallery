<script lang="ts">
  import { Icon } from '@immich/ui';
  import { mdiChevronDown, mdiChevronRight, mdiMagnify } from '@mdi/js';
  import { onDestroy, untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { FilterContext } from './filter-panel';

  interface Props {
    countries: string[];
    selectedCity?: string;
    selectedCountry?: string;
    selectedState?: string;
    context?: FilterContext;
    /** Includes the surface, permission scope and smart-search query, even if countries stay the same. */
    scopeKey?: string;
    onStateFetch?: (country: string, context?: FilterContext) => Promise<string[]>;
    onCityFetch: (country: string, context?: FilterContext) => Promise<string[]>;
    onSelectionChange: (country?: string, city?: string, state?: string) => void;
    emptyText?: string;
  }

  let {
    countries,
    selectedCity,
    selectedCountry,
    selectedState,
    context,
    scopeKey,
    onStateFetch,
    onCityFetch,
    onSelectionChange,
    emptyText,
  }: Props = $props();

  const SHOW_COUNT = 10;
  const MIN_SEARCH_LENGTH = 2;
  const MAX_CONCURRENT_REQUESTS = 4;
  let searchQuery = $state('');
  let showAllCountries = $state(false);
  let showAllChildren = $state<Record<string, boolean>>({});
  let expandedCountry = $state<string>();
  let expandedStates = $state<Record<string, string | undefined>>({});
  let expandedAllCities = $state<Record<string, boolean>>({});
  let manualCountries = $state<Record<string, boolean>>({});
  let cache = $state<Record<string, string[]>>({});
  let pending = $state<Record<string, boolean>>({});
  let errors = $state<Record<string, boolean>>({});
  let cacheKey = $state('');
  let generation = 0;
  let activeRequests = 0;
  let disposed = false;
  let queue: Array<() => void> = [];

  const stateKey = (country: string) => JSON.stringify(['states', country]);
  const cityKey = (country: string, state?: string) => JSON.stringify(['cities', country, state ?? null]);
  let query = $derived(searchQuery.trim().toLowerCase());
  let searchChildren = $derived(query.length >= MIN_SEARCH_LENGTH);
  const matches = (value: string) => value.toLowerCase().includes(query);

  function drain() {
    while (!disposed && activeRequests < MAX_CONCURRENT_REQUESTS && queue.length > 0) queue.shift()!();
  }

  function ensure(kind: 'states' | 'cities', country: string, state?: string, retry = false) {
    const key = kind === 'states' ? stateKey(country) : cityKey(country, state);
    if (Object.hasOwn(cache, key) || pending[key] || (errors[key] && !retry)) return;
    const requestGeneration = generation;
    const fetcher = kind === 'states' ? onStateFetch : onCityFetch;
    const requestContext = state ? { ...context, state } : context;
    pending = { ...pending, [key]: true };
    errors = { ...errors, [key]: false };
    queue.push(() => {
      activeRequests++;
      void Promise.resolve()
        .then(() => fetcher?.(country, requestContext) ?? [])
        .then((values) => {
          if (disposed || generation !== requestGeneration) return;
          cache = { ...cache, [key]: [...new Set(values.filter(Boolean))] };
          pending = { ...pending, [key]: false };
        })
        .catch(() => {
          if (disposed || generation !== requestGeneration) return;
          pending = { ...pending, [key]: false };
          errors = { ...errors, [key]: true };
        })
        .finally(() => {
          activeRequests--;
          drain();
        });
    });
    drain();
  }

  onDestroy(() => {
    disposed = true;
    queue = [];
  });

  $effect(() => {
    // Countries are the result of the same suggestion request and may arrive after URL hydration;
    // they are not a cache boundary themselves. Context/scope changes are the actual query changes.
    const nextKey = JSON.stringify({ context, scopeKey });
    untrack(() => {
      if (cacheKey && cacheKey !== nextKey) {
        generation++;
        queue = [];
        cache = {};
        pending = {};
        errors = {};
        showAllChildren = {};
      }
      cacheKey = nextKey;
    });
  });

  // Default expansion is UI state only; a manual fold survives selection/context refetches.
  $effect(() => {
    const single = countries.length === 1 ? countries[0] : undefined;
    untrack(() => {
      if (single && manualCountries[single] === undefined) expandedCountry = single;
    });
  });

  // Reveal URL/contextual selections once when the selection changes, never on manual folding.
  $effect(() => {
    const country = selectedCountry;
    const state = selectedState;
    const city = selectedCity;
    untrack(() => {
      if (!country || (!state && !city)) return;
      expandedCountry = country;
      if (state && city) expandedStates = { ...expandedStates, [country]: state };
      if (!state && city) {
        expandedAllCities = { ...expandedAllCities, [country]: true };
      }
    });
    if (country && city && !state) ensure('cities', country);
  });

  $effect(() => {
    cacheKey;
    if (!expandedCountry || !countries.includes(expandedCountry)) return;
    const country = expandedCountry;
    const state = expandedStates[country];
    const allCities = expandedAllCities[country];
    const legacy = !onStateFetch;
    untrack(() => {
      ensure('states', country);
      if (state) ensure('cities', country, state);
      if (allCities || legacy) ensure('cities', country);
    });
  });

  // Suggestion responses can replace the country list after URL state has already hydrated. The
  // cache generation is reset with that scope change, so explicitly requeue the visible city.
  $effect(() => {
    const country = selectedCountry;
    const city = selectedCity;
    const state = selectedState;
    cacheKey;
    if (country && city && countries.includes(country) && !selectedState) {
      untrack(() => ensure('cities', country));
    }
    if (country && state && !onStateFetch) {
      untrack(() => ensure('cities', country));
    }
  });

  // Search is debounced. Country-wide cities locate matching countries; only those countries
  // need per-state city requests to resolve the hierarchy. All requests share a bounded queue.
  $effect(() => {
    cacheKey;
    if (!searchChildren) return;
    const currentQuery = query;
    const currentCountries = countries;
    const timeout = setTimeout(
      () =>
        untrack(() => {
          if (query !== currentQuery) return;
          for (const country of currentCountries) {
            ensure('states', country);
            ensure('cities', country);
          }
        }),
      150,
    );
    return () => clearTimeout(timeout);
  });

  $effect(() => {
    if (!searchChildren || !onStateFetch) return;
    for (const country of countries) {
      if ((cache[cityKey(country)] ?? []).some(matches)) {
        for (const state of cache[stateKey(country)] ?? []) untrack(() => ensure('cities', country, state));
      }
    }
  });

  function isCitySelected(country: string, city: string, state?: string) {
    return selectedCity === city && (!selectedCountry || selectedCountry === country) && selectedState === state;
  }

  function statesFor(country: string) {
    const values = cache[stateKey(country)] ?? [];
    const selected = selectedCountry === country ? selectedState : undefined;
    const available = selected && !values.includes(selected) ? [...values, selected] : values;
    if (!query || (expandedCountry === country && matches(country))) return available;
    return available.filter(
      (state) =>
        state === selected ||
        (searchChildren && (matches(state) || (cache[cityKey(country, state)] ?? []).some(matches))),
    );
  }

  function citiesFor(country: string, state?: string) {
    const values = cache[cityKey(country, state)] ?? [];
    const selected = selectedCountry === country && selectedState === state ? selectedCity : undefined;
    const filtered =
      !query || (expandedCountry === country && matches(country)) || (state && matches(state))
        ? values
        : searchChildren
          ? values.filter(matches)
          : [];
    // Keep a URL-restored city visible while its country has fallen out of the current facet set,
    // but wait for the scoped provider when the country is present so we do not render a lone city
    // before its siblings have loaded.
    return selected && !filtered.includes(selected) && (!countries.includes(country) || values.length > 0)
      ? [...filtered, selected]
      : filtered;
  }

  function limited(values: string[], key: string, selected?: string) {
    if (showAllChildren[key]) return values;
    const head = values.slice(0, SHOW_COUNT);
    return selected && values.includes(selected) && !head.includes(selected)
      ? [...head.slice(0, SHOW_COUNT - 1), selected]
      : head;
  }

  let filteredCountries = $derived(
    countries.filter(
      (country) =>
        !query ||
        matches(country) ||
        selectedCountry === country ||
        (searchChildren && (statesFor(country).length > 0 || (cache[cityKey(country)] ?? []).some(matches))),
    ),
  );
  let visibleCountries = $derived.by(() => {
    if (query || showAllCountries) return filteredCountries;
    const head = filteredCountries.slice(0, SHOW_COUNT);
    return selectedCountry && filteredCountries.includes(selectedCountry) && !head.includes(selectedCountry)
      ? [selectedCountry, ...filteredCountries.filter((country) => country !== selectedCountry)].slice(0, SHOW_COUNT)
      : head;
  });
  let pendingSearch = $derived(
    searchChildren &&
      countries.some((country) =>
        [stateKey(country), cityKey(country)].some(
          (key) => pending[key] || (!Object.hasOwn(cache, key) && !errors[key]),
        ),
      ),
  );
  let orphanedCountry = $derived(selectedCountry && !countries.includes(selectedCountry) ? selectedCountry : undefined);
  let cityOnlyHasRow = $derived(
    !selectedCountry &&
      !selectedState &&
      !!selectedCity &&
      visibleCountries.some(
        (country) => (expandedCountry === country || searchChildren) && citiesFor(country).includes(selectedCity!),
      ),
  );

  function change(country?: string, city?: string, state?: string) {
    if (state === undefined) onSelectionChange(country, city);
    else onSelectionChange(country, city, state);
  }

  function selectCountry(country: string) {
    expandedCountry = country;
    manualCountries = { ...manualCountries, [country]: false };
    ensure('states', country);
    if (!onStateFetch) ensure('cities', country);
    change(selectedCountry === country && !selectedCity && !selectedState ? undefined : country);
  }

  function selectState(country: string | undefined, state: string) {
    change(
      country,
      undefined,
      selectedCountry === country && selectedState === state && !selectedCity ? undefined : state,
    );
  }

  function selectCity(country: string | undefined, city: string, state?: string) {
    const selected =
      selectedCity === city && (!selectedCountry || country === selectedCountry) && selectedState === state;
    change(selected && !selectedCountry ? undefined : country, selected ? undefined : city, state);
  }

  function toggleCountry(country: string) {
    const expand = expandedCountry !== country;
    manualCountries = { ...manualCountries, [country]: expand };
    expandedCountry = expand ? country : undefined;
    if (expand) {
      ensure('states', country, undefined, true);
      if (!onStateFetch) ensure('cities', country, undefined, true);
    }
  }
</script>

{#snippet indicator(selected: boolean)}
  <div
    class="flex size-4 shrink-0 items-center justify-center rounded-full border-2 {selected
      ? 'border-immich-primary bg-immich-primary dark:border-immich-dark-primary dark:bg-immich-dark-primary'
      : 'border-gray-300 dark:border-gray-600'}"
  >
    {#if selected}<div class="size-1.5 rounded-full bg-white dark:bg-black"></div>{/if}
  </div>
{/snippet}

{#snippet expandButton(label: string, expanded: boolean, testId: string, onclick: () => void)}
  <button
    type="button"
    class="shrink-0 rounded-lg p-1.5 text-gray-500 hover:bg-subtle dark:text-gray-300"
    aria-label={`${$t(expanded ? 'collapse' : 'expand')} ${label}`}
    aria-expanded={expanded}
    {onclick}
    data-testid={testId}
  >
    <Icon icon={expanded ? mdiChevronDown : mdiChevronRight} size="16" />
  </button>
{/snippet}

{#snippet stateButton(country: string | undefined, state: string)}
  {@const selected = selectedState === state && selectedCountry === country && !selectedCity}
  <button
    type="button"
    class="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-subtle {selected
      ? 'font-medium'
      : 'text-gray-500 dark:text-gray-300'}"
    onclick={() => selectState(country, state)}
    aria-pressed={selected}
    data-testid="location-state-{state}"
  >
    {@render indicator(selected)}<span class="flex-1 truncate text-left">{state}</span>
  </button>
{/snippet}

{#snippet cityList(country: string, state?: string)}
  {@const key = cityKey(country, state)}
  {@const values = citiesFor(country, state)}
  {@const visible = limited(
    values,
    key,
    selectedCountry === country && selectedState === state ? selectedCity : undefined,
  )}
  {#each visible as city (city)}
    {@const selected = isCitySelected(country, city, state)}
    <button
      type="button"
      class="-mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-subtle {state
        ? 'ml-10'
        : 'ml-5'} {selected ? 'font-medium' : 'text-gray-500 dark:text-gray-300'}"
      onclick={() => selectCity(country, city, state)}
      aria-pressed={selected}
      data-testid={state ? `location-city-${country}-${state}-${city}` : `location-city-${city}`}
    >
      {@render indicator(selected)}<span class="flex-1 truncate text-left">{city}</span>
    </button>
  {/each}
  {#if values.length > visible.length}
    <button
      type="button"
      class="ml-5 py-1 text-xs font-medium text-immich-primary dark:text-immich-dark-primary"
      onclick={() => (showAllChildren = { ...showAllChildren, [key]: true })}
      data-testid={state ? `location-city-show-more-${country}-${state}` : `location-city-show-more-${country}`}
    >
      {$t('filter_show_more', { values: { count: values.length - visible.length } })}
    </button>
  {/if}
{/snippet}

<div data-testid="location-filter">
  {#if countries.length === 0 && !selectedCountry && !selectedState && !selectedCity}
    <p class="text-sm text-gray-400 dark:text-gray-500" data-testid="location-empty">
      {emptyText ?? $t('filter_no_locations_found')}
    </p>
  {:else}
    <div class="relative mb-2">
      <div class="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-gray-400 dark:text-gray-500">
        <Icon icon={mdiMagnify} size="14" />
      </div>
      <input
        type="text"
        class="immich-form-input h-8 w-full rounded-lg pr-2 pl-7 text-sm"
        placeholder={$t('filter_search_locations')}
        bind:value={searchQuery}
        oninput={() => (showAllCountries = false)}
        data-testid="location-search-input"
      />
    </div>

    {#if orphanedCountry}
      <button
        type="button"
        class="-mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium opacity-50 hover:bg-subtle"
        onclick={() => selectCountry(orphanedCountry!)}
        aria-pressed={!selectedState && !selectedCity}
        data-testid="location-country-{orphanedCountry}"
      >
        {@render indicator(!selectedState && !selectedCity)}<span class="flex-1 truncate text-left"
          >{orphanedCountry}</span
        >
      </button>
      {#if selectedState}<div class="ml-5">{@render stateButton(orphanedCountry, selectedState)}</div>{/if}
      {#if selectedCity && Object.hasOwn(cache, cityKey(orphanedCountry, selectedState))}
        {@render cityList(orphanedCountry, selectedState)}
      {/if}
    {/if}
    {#if selectedState && !selectedCountry}{@render stateButton(undefined, selectedState)}{/if}
    {#if selectedCity && !selectedCountry && !cityOnlyHasRow}
      <button
        type="button"
        class="-mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium hover:bg-subtle"
        onclick={() => selectCity(undefined, selectedCity!, selectedState)}
        aria-pressed="true"
        data-testid="location-city-{selectedCity}"
      >
        {@render indicator(true)}<span class="flex-1 truncate text-left">{selectedCity}</span>
      </button>
    {/if}
    {#if query && filteredCountries.length === 0 && !pendingSearch}
      <p class="text-sm text-gray-400 dark:text-gray-500" data-testid="location-no-results">
        {$t('filter_no_matching_locations')}
      </p>
    {/if}

    {#each visibleCountries as country (country)}
      {@const selected = selectedCountry === country && !selectedCity && !selectedState}
      {@const expanded = expandedCountry === country}
      <div class="-mx-2 flex items-center">
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-subtle {selected
            ? 'font-medium'
            : 'text-gray-500 dark:text-gray-300'}"
          onclick={() => selectCountry(country)}
          aria-pressed={selected}
          data-testid="location-country-{country}"
        >
          {@render indicator(selected)}<span class="flex-1 truncate text-left">{country}</span>
        </button>
        {@render expandButton(country, expanded, `location-expand-country-${country}`, () => toggleCountry(country))}
      </div>
      {#if expanded || (searchChildren && statesFor(country).length > 0)}
        {@const values = statesFor(country)}
        {@const visible = limited(values, stateKey(country), selectedCountry === country ? selectedState : undefined)}
        {#each visible as state (state)}
          {@const stateExpanded = expandedStates[country] === state}
          <div class="-mx-2 ml-5 flex items-center">
            {@render stateButton(country, state)}
            {@render expandButton(state, stateExpanded, `location-expand-state-${country}-${state}`, () => {
              expandedStates = { ...expandedStates, [country]: stateExpanded ? undefined : state };
              if (!stateExpanded) ensure('cities', country, state, true);
            })}
          </div>
          {#if stateExpanded || (searchChildren && citiesFor(country, state).length > 0)}{@render cityList(
              country,
              state,
            )}{/if}
        {/each}
        {#if values.length > visible.length}
          <button
            type="button"
            class="ml-5 py-1 text-xs font-medium text-immich-primary dark:text-immich-dark-primary"
            onclick={() => (showAllChildren = { ...showAllChildren, [stateKey(country)]: true })}
            data-testid="location-state-show-more-{country}"
          >
            {$t('filter_show_more', { values: { count: values.length - visible.length } })}
          </button>
        {/if}
      {/if}
      {#if selectedCountry === country && selectedState && !statesFor(country).includes(selectedState)}
        <div class="ml-5">{@render stateButton(country, selectedState)}</div>
      {/if}
      {#if expanded && onStateFetch}
        <!-- Suggestions cannot distinguish null-state cities. A country-wide list keeps those
             cities reachable without inventing a province or issuing a request for every state. -->
        <div class="ml-5 flex items-center gap-1 text-sm text-gray-500 dark:text-gray-300">
          <span class="flex-1">{$t('filter_sheet_deep_places_all_cities')}</span>
          {@render expandButton(
            $t('filter_sheet_deep_places_all_cities'),
            !!expandedAllCities[country],
            `location-expand-cities-${country}`,
            () => {
              expandedAllCities = { ...expandedAllCities, [country]: !expandedAllCities[country] };
              if (expandedAllCities[country]) ensure('cities', country, undefined, true);
            },
          )}
        </div>
      {/if}
      {#if (expanded && (expandedAllCities[country] || statesFor(country).length === 0 || !onStateFetch)) || (searchChildren && citiesFor(country).length > 0)}
        {@render cityList(country)}
      {/if}
      {#if !expanded && selectedCountry === country && selectedState && !searchChildren}
        <div class="ml-5">{@render stateButton(country, selectedState)}</div>
      {/if}
    {/each}
    {#if !query && !showAllCountries && filteredCountries.length > visibleCountries.length}
      <button
        type="button"
        class="py-1 text-xs font-medium text-immich-primary dark:text-immich-dark-primary"
        onclick={() => (showAllCountries = true)}
        data-testid="location-show-more"
      >
        {$t('filter_show_more', { values: { count: filteredCountries.length - visibleCountries.length } })}
      </button>
    {/if}
  {/if}
</div>
