import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import * as z from "zod"
import { Button } from "@/components/ui/button"
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Globe, Languages, Sparkles, User, ArrowRight } from "lucide-react"

export const Route = createFileRoute('/onboarding')({
  component: OnboardingPage,
})

const formSchema = z.object({
  name: z.string().min(2, {
    message: "Name must be at least 2 characters.",
  }),
  country: z.string().min(1, {
    message: "Please select a country.",
  }),
  language: z.string().min(1, {
    message: "Please select a preferred language.",
  }),
})

const countries = [
  "United States", "United Kingdom", "Canada", "Australia", 
  "India", "Germany", "France", "Japan", "Brazil", "Egypt", 
  "Saudi Arabia", "United Arab Emirates", "Other"
].sort();

const languages = [
  { label: "English", value: "en" },
  { label: "Spanish (Español)", value: "es" },
  { label: "French (Français)", value: "fr" },
  { label: "German (Deutsch)", value: "de" },
  { label: "Hindi (हिन्दी)", value: "hi" },
  { label: "Chinese (中文)", value: "zh" },
  { label: "Arabic (العربية)", value: "ar" }
];

function OnboardingPage() {
  const navigate = useNavigate();
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      country: "",
      language: "",
    },
  })

  function onSubmit(values: z.infer<typeof formSchema>) {
    console.log("Onboarding preferences saved:", values)
    // Here we would typically save these preferences to the user's profile/settings
    navigate({ to: '/' });
  }

  return (
    <div className="min-h-screen flex w-full bg-background">
      {/* Left section: Decorative/Dashboard-y hero */}
      <div className="hidden lg:flex flex-1 flex-col justify-between bg-primary/5 p-12 border-r border-border/40 relative overflow-hidden">
        {/* Background ambient gradients */}
        <div className="absolute top-[-10%] left-[-10%] w-96 h-96 bg-primary/20 rounded-full blur-[100px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-96 h-96 bg-purple-500/20 rounded-full blur-[100px]" />
        
        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-16">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg">
              <Sparkles className="h-6 w-6" />
            </div>
            <span className="text-3xl font-bold tracking-tight text-foreground">OmNote</span>
          </div>
          
          <div className="space-y-6 max-w-md">
            <h1 className="text-4xl font-bold tracking-tight text-foreground lg:text-5xl leading-tight">
              Personalize your study experience.
            </h1>
            <p className="text-lg text-muted-foreground leading-relaxed">
              Tell us a bit about yourself. We'll optimize your workspace, language settings, and AI models to help you master concepts faster.
            </p>
          </div>
        </div>
        
        <div className="relative z-10 flex items-center gap-4 text-sm font-medium text-muted-foreground">
          <div className="flex -space-x-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-12 w-12 rounded-full border-[3px] border-background bg-secondary flex items-center justify-center overflow-hidden">
                <User className="h-5 w-5 text-secondary-foreground/50" />
              </div>
            ))}
          </div>
          <p className="text-base">Join thousands of students globally.</p>
        </div>
      </div>

      {/* Right section: Form */}
      <div className="flex-1 flex flex-col justify-center items-center p-6 sm:p-8 lg:p-12 relative">
        <div className="absolute top-8 right-8">
          <Button variant="ghost" onClick={() => navigate({ to: '/' })}>
            Skip for now
          </Button>
        </div>
        
        <div className="w-full max-w-md space-y-8 animate-in fade-in slide-in-from-bottom-8 duration-700">
          <div className="space-y-3 text-center lg:text-left">
            <h2 className="text-3xl font-bold tracking-tight">Welcome aboard!</h2>
            <p className="text-muted-foreground text-lg">Let's set up your account preferences.</p>
          </div>

          <div className="p-8 border border-border/50 rounded-3xl bg-card shadow-sm transition-all hover:shadow-md">
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="flex items-center gap-2 text-base">
                        <User className="h-4 w-4 text-primary" />
                        How should we call you?
                      </FormLabel>
                      <FormControl>
                        <Input 
                          placeholder="e.g. Dr. House or John" 
                          className="h-12 px-4 rounded-xl border-input/50 focus:border-primary transition-colors text-base"
                          {...field} 
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="country"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="flex items-center gap-2 text-base">
                        <Globe className="h-4 w-4 text-primary" />
                        Where are you studying?
                      </FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger className="h-12 px-4 rounded-xl border-input/50 transition-colors text-base">
                            <SelectValue placeholder="Select your country" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent className="rounded-xl max-h-60">
                          {countries.map(country => (
                            <SelectItem key={country} value={country} className="rounded-lg cursor-pointer">
                              {country}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormDescription>
                        This helps us tailor guidelines to your region.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="language"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="flex items-center gap-2 text-base">
                        <Languages className="h-4 w-4 text-primary" />
                        Preferred AI Language
                      </FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger className="h-12 px-4 rounded-xl border-input/50 transition-colors text-base">
                            <SelectValue placeholder="Select interface language" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent className="rounded-xl">
                          {languages.map(lang => (
                            <SelectItem key={lang.value} value={lang.value} className="rounded-lg cursor-pointer">
                              {lang.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormDescription>
                        OmNote's AI will generate content in this language.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="pt-2">
                  <Button 
                    type="submit" 
                    className="w-full h-14 rounded-xl text-lg font-medium bg-primary hover:bg-primary/90 transition-all shadow-md hover:shadow-lg flex items-center justify-center gap-2 group"
                  >
                    Complete Setup
                    <ArrowRight className="h-5 w-5 group-hover:translate-x-1 transition-transform" />
                  </Button>
                </div>
              </form>
            </Form>
          </div>
        </div>
      </div>
    </div>
  )
}
