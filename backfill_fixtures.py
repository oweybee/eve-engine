import os
import pandas as pd
from datetime import datetime
from statsbombpy import sb
from supabase import create_client, Client

# 1. INITIALIZE SUPABASE CLIENT USING MANAGEMENT ENVIRONMENT ROLES
SUPABASE_URL = os.getenv("NEXT_PUBLIC_SUPABASE_URL", "https://zlbmpeiuhyllxwegtayu.supabase.co")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "your-service-role-key") # Use service role key to pass RLS blocks

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

def backfill_world_cup_fixtures():
    # Competition ID 43 = Men's FIFA World Cup
    # Season IDs: 106 = Qatar 2022, 3 = Russia 2018
    world_cups = [
        {"season_id": 106, "year": "2022"},
        {"season_id": 3, "year": "2018"}
    ]

    records_to_insert = []

    for wc in world_cups:
        print(f"📡 Syncing metadata for World Cup {wc['year']} from StatsBomb core...")
        # Pulls high-level match arrays from open repository
        matches_df = sb.matches(competition_id=43, season_id=wc['season_id'])

        for _, row in matches_df.iterrows():
            match_id = row['match_id']
            home_team = row['home_team']
            away_team = row['away_team']
            home_score = row['home_score']
            away_score = row['away_score']
            match_date = row['match_date']

            print(f"  ⚽ Processing telemetry: {home_team} vs {away_team}")

            try:
                # Fetch full granular event frame (shots, passes, pressures)
                events = sb.events(match_id=match_id)

                # --- METRIC A: EXPLICIT EXPECTED GOALS COMPILATION ---
                shots = events[events['type'] == 'Shot']
                # Group and sum individual shot coordinates to get exact team xG
                xg_map = shots.groupby('team')['shot_statsbomb_xg'].sum().to_dict()

                home_xg = xg_map.get(home_team, 0.0)
                away_xg = xg_map.get(away_team, 0.0)

                # --- METRIC B: DEFENSIVE PRESSURING INTENSITY ---
                # Counts total pressing events to map out a proportional PPDA intensity index proxy
                pressures = events[events['type'] == 'Pressure'].groupby('team').size().to_dict()
                home_press = pressures.get(home_team, 0)
                away_press = pressures.get(away_team, 0)

                total_pressures = home_press + away_press
                ppda_proxy = 11.5 # Standard default midline marker

                if total_pressures > 0:
                    # Invert ratio so active high-pressing translates to a lower, sharper tactical value (8.0-14.0 range)
                    ppda_proxy = round(25.0 - (home_press / total_pressures) * 20.0, 2)
                    ppda_proxy = max(7.5, min(15.5, ppda_proxy))

                # Structure payload to match your exact engine/compute schema definitions
                fixture_id = f"wc_{wc['year']}_{match_id}"

                record = {
                    "fixture_id": fixture_id,
                    "match_kickoff_at": datetime.strptime(match_date, "%Y-%m-%d").isoformat(),
                    "home_team_name": home_team,
                    "away_team_name": away_team,
                    "home_goals_scored": int(home_score),
                    "away_goals_scored": int(away_score),
                    "xg_created": float(home_xg),
                    "xg_conceded": float(away_xg),
                    "ppda_intensity_index": float(ppda_proxy),
                    "model_architecture": "ML_ENSEMBLE",
                    "feature_completeness": True
                }

                records_to_insert.append(record)

            except Exception as e:
                print(f"  ❌ Skipping event frame evaluation on fixture {match_id}: {str(e)}")
                continue

    # Execute batch transactional upload to DB engine
    if records_to_insert:
        print(f"📦 Staging {len(records_to_insert)} high-alpha data matrices to Supabase...")
        try:
            supabase.table("fixture_predictions").upsert(records_to_insert).execute()
            print("✅ World Cup analytical backfill complete.")
        except Exception as e:
            print(f"❌ Transaction failed inside database tier: {str(e)}")

if __name__ == "__main__":
    backfill_world_cup_fixtures()
