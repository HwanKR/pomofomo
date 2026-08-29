'use server';

import { holidays } from '@kyungseopk1m/holidays-kr';

export async function getKoreanHolidays(year: string) {
    try {
        const response = await holidays(year);
        if (response.data) {
            return response.data.map((holiday) => holiday.date);
        }
        return [];
    } catch (error) {
        console.error("Failed to fetch holidays on server:", error);
        return [];
    }
}
