import 'server-only';
import { cache } from 'react';
import { loadData } from './data';

/** One load per request, shared by the layout's sidebar and the page. */
export const getData = cache(loadData);
