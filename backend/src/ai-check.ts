import 'dotenv/config';
import { appealAssistanceSchema, Groq } from './ai';

async function check() {
  const provider = new Groq();
  if (!provider.available()) throw new Error('Groq configuration is disabled or incompatible.');
  const result = await provider.complete('appeal_assist',
    'Верни подсказку по синтетическому учебному обращению. Для categoryId верни null.',
    JSON.stringify({ categories: [], text: 'В учебном шаблоне заявки не хватает даты. Это синтетические данные.' }),
    appealAssistanceSchema);
  const suggestion = appealAssistanceSchema.parse(result);
  if (suggestion.categoryId !== null) throw new Error('The provider suggested a category outside the input.');
  console.info('Groq synthetic structured-output check passed.');
}

void check().catch(() => { console.error('Groq check failed. Verify mode, model and account access.'); process.exitCode = 1; });
