import fetch from "node-fetch";

const API_URL = "https://exercisedb.p.rapidapi.com/exercises";

export async function fetchExercises() {
  const res = await fetch(API_URL, {
    method: "GET",
    headers: {
      "X-RapidAPI-Key": process.env.EXERCISE_DB_KEY!,
      "X-RapidAPI-Host": "exercisedb.p.rapidapi.com"
    }
  });

  const data = await res.json();

  // Normalize data for your app
  return data.slice(0, 20).map((ex: any) => ({
    name: ex.name,
    bodyPart: ex.bodyPart,
    target: ex.target,
    equipment: ex.equipment,
    gifUrl: ex.gifUrl,
    difficulty: mapDifficulty(ex)
  }));
}

function mapDifficulty(ex: any) {
  if (ex.bodyPart === "cardio") return "advanced";
  if (ex.equipment === "body weight") return "beginner";
  return "intermediate";
}
