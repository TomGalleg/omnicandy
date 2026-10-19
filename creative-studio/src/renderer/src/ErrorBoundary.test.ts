import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

describe('ErrorBoundary', () => {
  it('passes children through while nothing has failed', () => {
    expect(renderToStaticMarkup(createElement(ErrorBoundary, null, createElement('p', null, 'fine')))).toBe('<p>fine</p>');
  });

  it('turns a render error into a message with a reload button instead of a blank window', () => {
    const b = new ErrorBoundary({ children: null });
    b.state = ErrorBoundary.getDerivedStateFromError(new Error('boom'));
    const html = renderToStaticMarkup(b.render() as never);
    expect(html).toContain('Something went wrong');
    expect(html).toContain('boom');
    expect(html).toContain('Reload this view');
  });

  it('accepts a thrown non-Error value', () => {
    expect(ErrorBoundary.getDerivedStateFromError('plain text').error?.message).toBe('plain text');
  });
});
