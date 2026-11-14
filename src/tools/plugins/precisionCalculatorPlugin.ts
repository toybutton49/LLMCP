import { safeEvaluateArithmetic } from '../../utils/rag/promptAndMutations';
import type { HotSwappableToolPlugin } from '../types';

export const precisionCalculatorPlugin: HotSwappableToolPlugin = {
  definition: {
    id: 'precision_calculator',
    name: 'Calculator',
    category: 'Calculation',
    description: 'Evaluate a basic arithmetic expression deterministically.',
    parameterSummary: 'expression: string',
    version: '1.0.0',
    hotSwappable: true
  },
  aliases: ['calculator'],
  schema: {
    name: 'precision_calculator',
    description: 'Evaluate a basic arithmetic expression and return its exact numeric result.',
    parameters: {
      type: 'OBJECT',
      properties: {
        expression: {
          type: 'STRING',
          description: 'Arithmetic expression to evaluate.'
        }
      },
      required: ['expression']
    }
  },
  invokeDirect: (args) => {
    const expression = typeof args.expression === 'string' ? args.expression.trim() : '';
    const result = expression ? safeEvaluateArithmetic(expression) : null;
    return {
      pluginId: 'precision_calculator',
      pluginName: 'Calculator',
      inputSummary: expression ? `Expression: ${expression}` : 'No expression provided',
      outputSummary: result === null ? 'Unable to evaluate this expression.' : `Result: ${result}`,
      durationMs: 1
    };
  }
};
