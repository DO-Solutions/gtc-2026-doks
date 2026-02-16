import { useState, useEffect, useCallback } from 'react';

export type Route =
  | { page: 'dashboard' }
  | { page: 'conversations' }
  | { page: 'conversation-detail'; conversationId: string };

function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  if (path === 'conversations') {
    return { page: 'conversations' };
  }
  const detailMatch = path.match(/^conversations\/(.+)$/);
  if (detailMatch) {
    return { page: 'conversation-detail', conversationId: decodeURIComponent(detailMatch[1]) };
  }
  return { page: 'dashboard' };
}

export function useHashRouter() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = useCallback((hash: string) => {
    window.location.hash = hash;
  }, []);

  return { route, navigate };
}
