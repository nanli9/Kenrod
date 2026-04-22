import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const body = await request.json();
  const { name, email, message } = body;

  if (!name || !email || !message) {
    return NextResponse.json(
      { error: 'All fields are required' },
      { status: 400 }
    );
  }

  // MVP: log the contact submission. Replace with email/database later.
  console.log('Contact form submission:', { name, email, message });

  return NextResponse.json({ success: true });
}
