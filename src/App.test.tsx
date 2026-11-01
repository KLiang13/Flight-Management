import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import * as dclScenario from './dcl/dclScenario';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Flight operations dashboard', () => {
  it('renders the Vietnamese title and the map, queue, and DCL event regions', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: /ứng dụng cpdlc- dcl trong quản lý luồng không lưu/i })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /parking chart/i })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /hàng chờ cất cánh/i })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /bản tin dcl/i })).toBeInTheDocument();
    expect(screen.getByAltText(/sơ đồ đường băng, đường lăn và vị trí đỗ/i)).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'TSAT' })).toBeInTheDocument();
  });

  it('keeps the page rendered after loading a flight CSV and running the simulation', async () => {
    const csvText = 'AirportDeliveryCode,AirportReceiptCode,CallSign,PlaneTypeCode,FlyDate,DeliveryTime\nVVTS,VVDN,VNA123,A320,03/11/23,05:00';
    const file = new File([csvText], 'flights.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode(csvText).buffer });
    const handle = { getFile: vi.fn().mockResolvedValue(file) };
    vi.stubGlobal('showOpenFilePicker', vi.fn().mockResolvedValue([handle]));
    Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: vi.fn().mockResolvedValue([handle]) });
    const clearanceSpy = vi.spyOn(dclScenario, 'createDclEvents');
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /tải tệp mới/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /chạy mô phỏng/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /chạy mô phỏng/i }));
    await waitFor(() => expect(screen.getAllByText('VNA123').length).toBeGreaterThan(0));
    expect(screen.getByRole('heading', { name: /ứng dụng cpdlc- dcl trong quản lý luồng không lưu/i })).toBeInTheDocument();
    const dclBoard = screen.getByRole('table', { name: /bảng điện văn dcl/i });
    expect(dclBoard).toHaveTextContent('GIỜ');
    expect(screen.getByRole('columnheader', { name: 'TSAT' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('slider', { name: /tua thời gian mô phỏng/i }), { target: { value: '1440' } });
    await waitFor(() => expect(dclBoard).toHaveTextContent('CLD'));
    expect(dclBoard).toHaveTextContent('TSAT');
    expect(screen.getAllByText('VNA123').length).toBeGreaterThan(0);
    const pause = screen.queryByRole('button', { name: /tạm dừng mô phỏng/i });
    if (pause) fireEvent.click(pause);
    const slider = screen.getByRole('slider', { name: /tua thời gian mô phỏng/i });
    const rcdTime = clearanceSpy.mock.calls[0][1];
    const tsat = clearanceSpy.mock.calls[0][3]!.tsat!;
    const dayStart = new Date(rcdTime).setHours(0, 0, 0, 0);
    const seek = (time: number) => fireEvent.change(slider, { target: { value: String((time - dayStart) / 60_000) } });
    seek(rcdTime - 1);
    expect(dclBoard).not.toHaveTextContent('RCD VNA123');
    expect(screen.queryByRole('button', { name: /VNA123, tàu đi/ })).not.toBeInTheDocument();
    seek(rcdTime);
    expect(dclBoard).toHaveTextContent('RCD VNA123');
    expect(screen.getByRole('button', { name: /VNA123, tàu đi/ })).toBeInTheDocument();
    expect(screen.getByText('TỔNG THỜI GIAN CHỜ').closest('article')?.querySelector('.kpi-value')).toHaveTextContent('0 phút');
    seek(tsat + 1000);
    expect(screen.getByText('TỔNG THỜI GIAN CHỜ').closest('article')?.querySelector('.kpi-value')).toHaveTextContent(/^0 phút$/);
    fireEvent.change(slider, { target: { value: '0' } });
    expect(screen.getByText('TỔNG THỜI GIAN CHỜ').closest('article')?.querySelector('.kpi-value')).toHaveTextContent('0 phút');
    const rain = screen.getByRole('switch', { name: 'Thời tiết xấu' });
    fireEvent.click(rain);
    expect(rain).toHaveAttribute('aria-checked', 'true');
    fireEvent.change(slider, { target: { value: '600' } });
    expect(screen.getByRole('region', { name: 'Hàng chờ cất cánh' })).toHaveTextContent('Chờ thời tiết tốt');
    fireEvent.click(rain);
    expect(rain).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('region', { name: 'Hàng chờ cất cánh' })).toHaveTextContent('Đã cấp TSAT mới');
    expect(dclBoard).toHaveTextContent('TSAT REVISED');
    const revised = document.querySelector('.time-cell[title*="TSAT mới"]')?.getAttribute('title')?.match(/TSAT mới (\d{2}):(\d{2})/);
    expect(revised).not.toBeNull();
    const startupMinute = Number(revised![1]) * 60 + Number(revised![2]);
    let takeoffVisible = false;
    for (let minute = startupMinute; minute <= startupMinute + 30 && !takeoffVisible; minute += 1) {
      fireEvent.change(slider, { target: { value: String(minute) } });
      takeoffVisible = screen.queryByRole('button', { name: /VNA123.*cất cánh 25L/i }) !== null;
    }
    expect(takeoffVisible).toBe(true);
    fireEvent.change(slider, { target: { value: '1440' } });
    expect(screen.getByText('TỔNG THỜI GIAN CHỜ').closest('article')?.querySelector('.kpi-value')).toHaveTextContent(/^0 phút$/);
  });
});

describe('independent weather bulletin', () => {
  it('broadcasts adverse weather without inserting a DCL telegram', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Thời tiết xấu' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('switch', { name: 'Thời tiết xấu' }));
    expect(screen.getByRole('region', { name: 'Bản tin thời tiết' })).toHaveTextContent('ADVERSE WEATHER');
    expect(screen.getByRole('table', { name: 'Bảng điện văn DCL' })).not.toHaveTextContent('ADVERSE WEATHER');
    fireEvent.click(screen.getByRole('switch', { name: 'Thời tiết xấu' }));
    expect(screen.getByRole('region', { name: 'Bản tin thời tiết' })).toHaveTextContent('Thời tiết tốt');
  });
});
