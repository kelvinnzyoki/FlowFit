const API_URL = 'https://exercisedb.p.rapidapi.com/exercises';

export async function fetchExercises() {
  const res = await fetch(API_URL, {
    method: 'GET',
    headers: {
      'X-RapidAPI-Key':  process.env.EXERCISE_DB_KEY!,
      'X-RapidAPI-Host': 'exercisedb.p.rapidapi.com',
    },
  });

  if (!res.ok) {
    throw new Error(`ExerciseDB API error: ${res.status} ${res.statusText}`);
  }

  // Cast to any[] — the ExerciseDB API returns a JSON array.
  // Without the cast, TypeScript infers res.json() as Promise<unknown>
  // and then data.slice() / data.map() fail type checking.
  const data = await res.json() as any[];

  return data.slice(0, 20).map((ex: any) => ({
    name:       ex.name,
    bodyPart:   ex.bodyPart,
    target:     ex.target,
    equipment:  ex.equipment,
    gifUrl:     ex.gifUrl,
    difficulty: mapDifficulty(ex),
  }));
}

function mapDifficulty(ex: any): string {
  if (ex.bodyPart === 'cardio')          return 'advanced';
  if (ex.equipment === 'body weight')    return 'beginner';
  return 'intermediate';
}
