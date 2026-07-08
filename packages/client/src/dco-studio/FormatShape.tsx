import React from 'react';

// Mini preview de aspecto de formato — usado en el checklist de formatos del modo manual.
export const FormatShape: React.FC<{ formatId: string }> = ({ formatId }) => {
    const shapes: Record<string, { w: number; h: number }> = {
        feed_square: { w: 18, h: 18 }, feed_portrait: { w: 14, h: 18 }, story_vertical: { w: 10, h: 18 },
        banner_billboard: { w: 24, h: 6 }, banner_skyscraper: { w: 6, h: 20 },
        banner_halfpage: { w: 10, h: 18 }, banner_mrec: { w: 14, h: 10 }, feed_landscape: { w: 24, h: 13 },
    };
    const s = shapes[formatId] || { w: 14, h: 14 };
    return (
        <div style={{ width: s.w, height: s.h, borderRadius: 2, border: '1.5px solid currentColor', flexShrink: 0, opacity: 0.6 }} />
    );
};
