import v01 from '../catalog/v01.json';
import type { Model } from './types';

export * from './types';

export const MODEL_V01 = v01 as unknown as Model;

export function questionsOf(model: Model, dimension: string) {
  return model.questions.filter((q) => q.dimension === dimension);
}
